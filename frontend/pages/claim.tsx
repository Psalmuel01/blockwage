import { useState } from "react";
import { ethers } from "ethers";
import axios from "axios";

export default function ClaimPage() {
  const [employeeAddress, setEmployeeAddress] = useState("");
  const [status, setStatus] = useState("");
  const [paymentReq, setPaymentReq] = useState<any>(null);

  async function checkClaim() {
    setStatus("Checking salary...");
    try {
      const res = await axios
        .get(`http://localhost:3001/salary/claim/${employeeAddress}`)
        .catch((err) => err.response);

      if (res.status === 402) {
        setPaymentReq(res.data.paymentRequirements);
        setStatus("Payment required - ready to claim!");
      } else if (res.status === 200) {
        setStatus("Already paid for this period");
      } else {
        setStatus(`Error: ${res.data.error}`);
      }
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
  }

  async function executePayment() {
    if (!paymentReq) return;

    setStatus("Sign the payment authorization in your wallet...");

    try {
      // Connect wallet
      const winEth = (window as any).ethereum;
      const provider = new ethers.BrowserProvider(winEth);
      const signer = await provider.getSigner();

      // Create EIP-3009 signature
      const domain = {
        name: "USD Coin",
        version: "2",
        chainId: 338, // Cronos testnet
        verifyingContract: paymentReq.asset,
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value = {
        from: await signer.getAddress(),
        to: paymentReq.payTo,
        value: paymentReq.maxAmountRequired,
        validAfter: 0,
        validBefore: Math.floor(Date.now() / 1000) + 3600,
        nonce: ethers.hexlify(ethers.randomBytes(32)),
      };

      const signature = await signer.signTypedData(domain, types, value);

      setStatus("Submitting to facilitator...");

      // Submit to Cronos Facilitator
      const facilitatorRes = await axios.post(
        `${paymentReq.facilitatorUrl}/settle`,
        {
          x402Version: 1,
          paymentHeader: ethers.encodeBase64(signature),
          paymentRequirements: paymentReq,
        }
      );

      setStatus(`✅ Payment successful! TX: ${facilitatorRes.data.txHash}`);
    } catch (err: any) {
      setStatus(`❌ Error: ${err.message}`);
    }
  }

  return (
    <div className="container mx-auto p-6 max-w-2xl">
      <h1 className="text-3xl font-bold mb-6">Claim Salary</h1>

      <div className="space-y-4">
        <input
          placeholder="Your wallet address (0x...)"
          value={employeeAddress}
          onChange={(e) => setEmployeeAddress(e.target.value)}
          className="w-full px-4 py-2 border rounded"
        />

        <button
          onClick={checkClaim}
          className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Check My Salary
        </button>

        {status && <div className="p-4 bg-gray-100 rounded">{status}</div>}

        {paymentReq && (
          <div className="p-4 border rounded">
            <h3 className="font-semibold mb-2">Payment Details</h3>
            <p>
              Amount: {ethers.formatUnits(paymentReq.maxAmountRequired, 6)} USDC
            </p>
            <p className="text-sm text-gray-600 mb-4">
              {paymentReq.description}
            </p>

            <button
              onClick={executePayment}
              className="w-full px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
            >
              Sign & Claim Salary
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
