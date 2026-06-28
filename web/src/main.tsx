import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { Providers } from "./providers.tsx";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><Providers><App /></Providers></React.StrictMode>,
);
