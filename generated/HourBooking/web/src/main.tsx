import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Timesheet from "./Timesheet";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Timesheet />
  </StrictMode>,
);
