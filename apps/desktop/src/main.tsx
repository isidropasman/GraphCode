import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { client } from "./store";
import "./styles.css";

void client.connect();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
