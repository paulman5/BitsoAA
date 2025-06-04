// app/swap/page.tsx
"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useReadContracts } from "wagmi"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import {
  ArrowUpDown,
  Copy,
  ExternalLink,
  RefreshCw,
  CheckCircle,
  Loader2,
} from "lucide-react"
import { useDynamicContext } from "@dynamic-labs/sdk-react-core"
import { useSmartAccount } from "@/hooks/useSmartaccount"
import { ethers } from "ethers"
import erc20Abi from "@/abi/erc20.json"
import { formatUnits, parseUnits, encodeFunctionData } from "viem"
import type { Abi } from "viem"
import mockSwapAbi from "@/abi/mockswap.json"
import { createPublicClient, http } from "viem"
import { sepolia } from "viem/chains"

const tokens: {
  address: `0x${string}`
  symbol: string
  icon: string
  formatted?: string
}[] = [
  {
    address: "0x6c6Dc940F2E6a27921df887AD96AE586abD8EfD8", // mUSDC
    symbol: "USDC",
    icon: "💵",
  },
  {
    address: "0x2eC77FDcb56370A3C0aDa518DDe86D820d76743B", // mPEPE
    symbol: "PEPE",
    icon: "🐸",
  },
]

// Your deployed MockSwap on Sepolia:
const MOCK_SWAP_ADDRESS =
  "0x718421BB9a6Bb63D4A63295d59c12196c3e221Ed" as `0x${string}`

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(),
})

const pollForAllowance = async (
  owner: `0x${string}`,
  spender: `0x${string}`,
  expectedAmount: bigint,
  tokenAddress: `0x${string}`,
  maxTries = 20
): Promise<boolean> => {
  for (let i = 0; i < maxTries; i++) {
    const allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi as Abi,
      functionName: "allowance",
      args: [owner, spender],
    })
    if (BigInt(allowance as string) >= expectedAmount) {
      return true
    }
    // Wait 2 seconds before retry
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return false
}

export default function TokenSwapDApp() {
  const [fromToken, setFromToken] = useState(tokens[0])
  const [toToken, setToToken] = useState(tokens[1])
  const [fromAmount, setFromAmount] = useState("")
  const [toAmount, setToAmount] = useState("")
  const [isConnected, setIsConnected] = useState(false)
  const [isSwapping, setIsSwapping] = useState(false)
  const [swapStatus, setSwapStatus] = useState<
    null | "pending" | "success" | "error"
  >(null)

  const { primaryWallet } = useDynamicContext()
  const { accountAddress } = useSmartAccount()

  // Fetch balances & decimals via wagmi:
  const { data, isLoading } = useReadContracts({
    contracts: tokens.flatMap((token) => [
      {
        address: token.address,
        abi: erc20Abi as Abi,
        functionName: "balanceOf",
        args: [accountAddress!],
      },
      {
        address: token.address,
        abi: erc20Abi as Abi,
        functionName: "decimals",
      },
    ]),
    allowFailure: false,
    query: {
      enabled: !!accountAddress,
    },
  })

  const TokenBalances = tokens.map((token, i) => {
    const balanceRaw = data?.[i * 2] as bigint | undefined
    const decimals = data?.[i * 2 + 1] as number | undefined
    const formatted =
      balanceRaw !== undefined && decimals !== undefined
        ? formatUnits(balanceRaw, decimals)
        : "-"
    return {
      ...token,
      formatted,
    }
  })

  useEffect(() => {
    if (primaryWallet) {
      setIsConnected(true)
    }
  }, [primaryWallet])

  const handleSwap = async () => {
    if (!fromAmount || !accountAddress) {
      return
    }

    setIsSwapping(true)
    setSwapStatus("pending")

    try {
      // 1) Get decimals & parse the "fromAmount" to BigInt:
      const decimals = Number(
        data?.[
          tokens.findIndex((t) => t.symbol === fromToken.symbol) * 2 + 1
        ] ?? 18
      )
      const amountBigInt = parseUnits(fromAmount, decimals)

      // 2) Encode the ERC20.approve(...) call to let MockSwap pull tokens:
      const approveData = encodeFunctionData({
        abi: erc20Abi as Abi,
        functionName: "approve",
        args: [MOCK_SWAP_ADDRESS, amountBigInt],
      })

      // 3) Send the approve UserOp:
      const approveRes = await fetch("/api/smartaccount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calls: [
            {
              to: fromToken.address,
              data: approveData,
            },
          ],
        }),
      })
      const approveJson = await approveRes.json()
      if (!approveRes.ok) {
        throw new Error(approveJson.error || "Approve step failed")
      }
      // At this point, /api/smartaccount waited until the approve UserOp was mined
      // (because we added `await client.waitForUserOperationReceipt(...)` in the API).

      // 4) Poll on-chain until the allowance is actually ≥ amountBigInt
      const allowanceOk = await pollForAllowance(
        accountAddress as `0x${string}`,
        MOCK_SWAP_ADDRESS,
        amountBigInt,
        fromToken.address
      )
      if (!allowanceOk) {
        throw new Error("Allowance did not update in time.")
      }

      // 5) Now that allowance is on-chain, encode swapAToB(amountBigInt):
      const swapData = encodeFunctionData({
        abi: mockSwapAbi.abi,
        functionName: "swapAToB",
        args: [amountBigInt],
      })

      // 6) Send the swap UserOp:
      const swapRes = await fetch("/api/smartaccount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calls: [
            {
              to: MOCK_SWAP_ADDRESS,
              data: swapData,
            },
          ],
        }),
      })
      const swapJson = await swapRes.json()
      if (!swapRes.ok) {
        throw new Error(swapJson.error || "Swap step failed")
      }

      // The API again will not return until that swap UserOp is mined (because of waitForUserOperationReceipt).
      setSwapStatus("success")
    } catch (err: any) {
      console.error("Swap error:", err)
      setSwapStatus("error")
    } finally {
      setIsSwapping(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-8">
        <div className="grid lg:grid-cols-3 gap-8 max-w-7xl mx-auto">
          {/* Main Swap Interface */}
          <div className="lg:col-span-2">
            <Card className="border-0 shadow-xl bg-white/90 backdrop-blur-sm">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-2xl font-bold text-gray-900">
                    Token Swap
                  </CardTitle>
                  <Badge
                    variant="secondary"
                    className="bg-blue-50 text-blue-700 border-blue-200"
                  >
                    Gas Sponsored
                  </Badge>
                </div>
                {isConnected && (
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <span>Smart Account: {accountAddress}</span>
                    <code className="bg-gray-100 rounded text-xs">
                      {accountAddress}
                    </code>
                  </div>
                )}
              </CardHeader>

              <CardContent className="space-y-6">
                {/* From Token */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">
                    From
                  </label>
                  <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-4 border border-blue-100">
                    <div className="flex items-center justify-between mb-3">
                      <Select
                        value={fromToken.symbol}
                        onValueChange={(value) => {
                          const token = tokens.find((t) => t.symbol === value)
                          if (token) setFromToken(token)
                        }}
                      >
                        <SelectTrigger className="w-auto border-0 bg-white/80 shadow-sm">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">{fromToken.icon}</span>
                            <SelectValue />
                          </div>
                        </SelectTrigger>
                        <SelectContent>
                          {tokens.map((token) => (
                            <SelectItem key={token.symbol} value={token.symbol}>
                              <div className="flex items-center gap-2">
                                <span>{token.icon}</span>
                                <span>{token.symbol}</span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <div className="text-right">
                        <Input
                          type="number"
                          placeholder="0.0"
                          value={fromAmount}
                          onChange={(e) => setFromAmount(e.target.value)}
                          className="text-right text-xl font-semibold border-0 bg-transparent p-0 h-auto"
                        />
                        <div className="text-xs text-gray-500 mt-1">
                          Balance:{" "}
                          {TokenBalances.find(
                            (t) => t.symbol === fromToken.symbol
                          )?.formatted ?? "-"}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Swap Direction */}
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const temp = fromToken
                      setFromToken(toToken)
                      setToToken(temp)
                      setFromAmount(toAmount)
                      setToAmount(fromAmount)
                    }}
                    className="rounded-full w-10 h-10 p-0 border-2 bg-white hover:bg-gray-50"
                  >
                    <ArrowUpDown className="w-4 h-4" />
                  </Button>
                </div>

                {/* To Token */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">
                    To
                  </label>
                  <div className="bg-gradient-to-r from-purple-50 to-pink-50 rounded-xl p-4 border border-purple-100">
                    <div className="flex items-center justify-between mb-3">
                      <Select
                        value={toToken.symbol}
                        onValueChange={(value) => {
                          const token = tokens.find((t) => t.symbol === value)
                          if (token) setToToken(token)
                        }}
                      >
                        <SelectTrigger className="w-auto border-0 bg-white/80 shadow-sm">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">{toToken.icon}</span>
                            <SelectValue />
                          </div>
                        </SelectTrigger>
                        <SelectContent>
                          {tokens.map((token) => (
                            <SelectItem key={token.symbol} value={token.symbol}>
                              <div className="flex items-center gap-2">
                                <span>{token.icon}</span>
                                <span>{token.symbol}</span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <div className="text-right">
                        <Input
                          type="number"
                          placeholder="0.0"
                          value={toAmount}
                          onChange={(e) => setToAmount(e.target.value)}
                          className="text-right text-xl font-semibold border-0 bg-transparent p-0 h-auto"
                        />
                        <div className="text-xs text-gray-500 mt-1">
                          Balance:{" "}
                          {TokenBalances.find(
                            (t) => t.symbol === toToken.symbol
                          )?.formatted ?? "-"}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Swap Button */}
                <Button
                  onClick={handleSwap}
                  disabled={!isConnected || !fromAmount || isSwapping}
                  className="w-full h-14 text-lg font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50"
                >
                  {isSwapping ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Swapping...
                    </>
                  ) : !isConnected ? (
                    "Connect Wallet to Swap"
                  ) : (
                    "Swap Tokens"
                  )}
                </Button>
                {swapStatus === "success" && (
                  <div className="text-green-600 text-center mt-2">
                    Swap successful!
                  </div>
                )}
                {swapStatus === "error" && (
                  <div className="text-red-600 text-center mt-2">
                    Swap failed. Please try again.
                  </div>
                )}

                {isConnected && (
                  <div className="text-center text-sm text-gray-600">
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle className="w-4 h-4 text-green-500" />
                      Gas fees sponsored by Paymaster
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Sidebar (Balances & History) */}
          <div className="space-y-6">
            {isConnected && (
              <Card className="border-0 shadow-lg bg-white/90 backdrop-blur-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">Account Balances</CardTitle>
                    <Button variant="ghost" size="sm">
                      <RefreshCw className="w-4 h-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {isLoading ? (
                    <div>Loading balances...</div>
                  ) : (
                    TokenBalances.map((token) => (
                      <div
                        key={token.symbol}
                        className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{token.icon}</span>
                          <div>
                            <div className="font-medium">{token.symbol}</div>
                            <div className="text-xs text-gray-500">
                              {token.formatted}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-medium">{token.formatted}</div>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            )}

            <Card className="border-0 shadow-lg bg-white/90 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">Transaction History</CardTitle>
                  <Button variant="ghost" size="sm">
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-center py-8 text-gray-500">
                  <div className="text-sm">No transactions yet</div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
