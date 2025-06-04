import { useEffect, useState } from "react"

export const useSmartAccount = () => {
  const [accountAddress, setAccountAddress] = useState<string | null>(null)
  const [kernelClient, setKernelClient] = useState<null>(null)

  useEffect(() => {
    const fetchAccount = async () => {
      const res = await fetch("/api/smartaccount")
      const data = await res.json()
      console.log("data", data)
      setAccountAddress(data.address)
      setKernelClient(data.kernelClient)
    }

    fetchAccount()
  }, [])

  return { accountAddress, kernelClient }
}
