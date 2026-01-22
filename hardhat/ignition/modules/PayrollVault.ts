import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("PayrollVaultModule", (m) => {
  const payrollVault = m.contract("PayrollVault", [
    "0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0", // devUSDC.e on Cronos testnet
    "0x96842251332aD2baf68Cd8538D2Fe8711BBA3939", // SalarySchedule contract address
    "0xB337fC04B8A146c93bCC7b57229Cc8cb18c03fd6", // PaymentVerifier contract address
  ]);

  return { payrollVault };
});
