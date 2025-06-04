// app/api/smartaccount/route.ts

import { NextResponse } from "next/server"
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
} from "@zerodev/sdk"
import { KERNEL_V3_1, getEntryPoint } from "@zerodev/sdk/constants"
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator"
import { http, createPublicClient, parseAbi } from "viem"
import { sepolia } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"

// ERC20 ABI (minimal)
const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) external view returns (uint256)",
])

export async function GET() {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}`
  const ZERODEV_RPC = process.env.ZERODEV_RPC!

  if (!privateKey || !ZERODEV_RPC) {
    return NextResponse.json({ error: "Missing env vars" }, { status: 500 })
  }

  try {
    const entryPoint = getEntryPoint("0.7")
    const kernelVersion = KERNEL_V3_1
    const chain = sepolia

    const signer = privateKeyToAccount(privateKey)

    const publicClient = createPublicClient({
      transport: http(ZERODEV_RPC),
      chain,
    })

    const validator = await signerToEcdsaValidator(publicClient, {
      signer,
      entryPoint,
      kernelVersion,
    })

    const account = await createKernelAccount(publicClient, {
      plugins: { sudo: validator },
      entryPoint,
      kernelVersion,
    })

    return NextResponse.json({ address: account.address })
  } catch (err: any) {
    console.error("API /api/smartaccount GET error:", err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}`
  const ZERODEV_RPC = process.env.ZERODEV_RPC!

  if (!privateKey || !ZERODEV_RPC) {
    return NextResponse.json({ error: "Missing env vars" }, { status: 500 })
  }

  try {
    const { calls } = await req.json()

    const entryPoint = getEntryPoint("0.7")
    const kernelVersion = KERNEL_V3_1
    const chain = sepolia

    const signer = privateKeyToAccount(privateKey)

    const publicClient = createPublicClient({
      transport: http(ZERODEV_RPC),
      chain,
    })

    const validator = await signerToEcdsaValidator(publicClient, {
      signer,
      entryPoint,
      kernelVersion,
    })

    const account = await createKernelAccount(publicClient, {
      plugins: { sudo: validator },
      entryPoint,
      kernelVersion,
    })

    const paymaster = createZeroDevPaymasterClient({
      chain,
      transport: http(ZERODEV_RPC),
    })

    const client = createKernelAccountClient({
      account,
      chain,
      bundlerTransport: http(ZERODEV_RPC),
      client: publicClient,
      paymaster: {
        getPaymasterData(userOp) {
          return paymaster.sponsorUserOperation({ userOperation: userOp })
        },
      },
    })

    // If there are two calls (approve + swap), handle them sequentially
    if (calls.length === 2) {
      // Encode and send approve
      try {
        const approveCallData = await account.encodeCalls([
          {
            to: calls[0].to,
            value: BigInt(0),
            data: calls[0].data,
          },
        ])
        const approveUserOpHash = await client.sendUserOperation({
          callData: approveCallData,
          preVerificationGas: BigInt(70000),
        })

        const approveReceipt = await client.waitForUserOperationReceipt({
          hash: approveUserOpHash,
        })

        // wait 5 seconds for the node state to update:
        await new Promise((resolve) => setTimeout(resolve, 30000))

        // Check on-chain allowance
        const allowance = await publicClient.readContract({
          address: calls[0].to, // token address
          abi: erc20Abi,
          functionName: "allowance",
          args: [account.address, calls[1].to],
        })

        // If allowance is still zero, return error
        if (BigInt(allowance as unknown as string) === BigInt(0)) {
          return NextResponse.json(
            { error: "Allowance not updated" },
            { status: 400 }
          )
        }
      } catch (approveErr: any) {
        console.error("Approve step failed:", approveErr)
        const message = approveErr.message || String(approveErr)
        return NextResponse.json(
          { error: `Approve failed: ${message}` },
          { status: 500 }
        )
      }

      // Encode and send swap
      try {
        const swapCallData = await account.encodeCalls([
          {
            to: calls[1].to,
            value: BigInt(0),
            data: calls[1].data,
          },
        ])
        const swapUserOpHash = await client.sendUserOperation({
          callData: swapCallData,
          preVerificationGas: BigInt(70000),
        })
        return NextResponse.json({ userOpHash: swapUserOpHash })
      } catch (swapErr: any) {
        console.error("Swap step failed:", swapErr)
        const message = swapErr.message || String(swapErr)
        return NextResponse.json(
          { error: `Swap failed: ${message}` },
          { status: 500 }
        )
      }
    } else {
      // Single call (approve or swap only)
      try {
        const userOpHash = await client.sendUserOperation({
          calls: calls.map((call: any) => ({
            to: call.to,
            value: BigInt(0),
            data: call.data,
          })),
          preVerificationGas: BigInt(70000),
        })
        return NextResponse.json({ userOpHash })
      } catch (singleErr: any) {
        console.error("Single call failed:", singleErr)
        const message = singleErr.message || String(singleErr)
        return NextResponse.json({ error: message }, { status: 500 })
      }
    }
  } catch (err: any) {
    console.error("API /api/smartaccount POST error:", err)
    const message = err.message || String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
