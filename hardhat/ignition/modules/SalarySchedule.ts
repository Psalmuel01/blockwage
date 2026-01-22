import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("SalaryScheduleModule", (m) => {
  const salarySchedule = m.contract("SalarySchedule", [
    "0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0", // devUSDC.e on Cronos testnet
  ]);

  return { salarySchedule };
});
