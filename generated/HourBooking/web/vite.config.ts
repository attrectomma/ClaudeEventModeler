import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API runs on 5080 (dotnet run). Proxying keeps fetch paths relative, so the same code works
// whether the page is served by Vite in development or by the API itself later.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/timesheet": { target: "http://localhost:5080", changeOrigin: true } },
  },
});
