import { NextResponse } from "next/server"
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseUnits,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator"
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
} from "@zerodev/sdk"
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants"

// ERC20 ABI (minimal)
const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) public returns (bool)",
  "function balanceOf(address owner) external view returns (uint256)",
])

const tokenAddress = "0x6c6Dc940F2E6a27921df887AD96AE586abD8EfD8" // mUSDC

export async function POST(req: Request) {
  try {
    const { recipient, amount } = await req.json()

    const privateKey = process.env.PRIVATE_KEY as `0x${string}`
    const ZERODEV_RPC = process.env.ZERODEV_RPC

    if (!privateKey || !ZERODEV_RPC) {
      return NextResponse.json({ error: "Missing env vars" }, { status: 500 })
    }

    const chain = sepolia
    const publicClient = createPublicClient({
      transport: http(ZERODEV_RPC),
      chain,
    })
    const entryPoint = getEntryPoint("0.7")

    const signer = privateKeyToAccount(privateKey)

    const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
      signer,
      entryPoint,
      kernelVersion: KERNEL_V3_1,
    })

    const account = await createKernelAccount(publicClient, {
      entryPoint,
      plugins: { sudo: ecdsaValidator },
      kernelVersion: KERNEL_V3_1,
    })

    const zerodevPaymaster = createZeroDevPaymasterClient({
      chain,
      transport: http(ZERODEV_RPC),
    })

    const kernelClient = createKernelAccountClient({
      account,
      chain,
      bundlerTransport: http(ZERODEV_RPC),
      paymaster: {
        getPaymasterData(userOperation) {
          return zerodevPaymaster.sponsorUserOperation({ userOperation })
        },
      },
    })

    // Prepare transfer call
    const decimals = 18 // mUSDC decimals
    const amountParsed = parseUnits(amount, decimals)

    const callData = await kernelClient.account.encodeCalls([
      {
        to: tokenAddress,
        value: BigInt(0),
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, amountParsed],
        }),
      },
    ])

    // Send UserOp
    const userOpHash = await kernelClient.sendUserOperation({
      callData,
      preVerificationGas: BigInt(70000),
    })

    // Wait for confirmation
    const receipt = await kernelClient.waitForUserOperationReceipt({
      hash: userOpHash,
    })

    // Optionally, return the new balance
    const balance = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [kernelClient.account.address],
    })

    return NextResponse.json({
      userOpHash,
      txHash: receipt.receipt.transactionHash,
      smartAccount: kernelClient.account.address,
      newBalance: balance.toString(),
    })
  } catch (err: any) {
    console.error("ERC20 transfer API error:", err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
