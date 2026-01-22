import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("PaymentVerifierModule", (m) => {
  const paymentVerifier = m.contract("PaymentVerifier");

  return { paymentVerifier };
});
