import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ToastProvider } from "./components/Toasts";
import "./styles/tokens.css";
import "./styles.css";
import "./styles/components.css";
import "./styles/flows.css";
import "./styles/activity.css";
import "./styles/delegate.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/panels.css";

// No StrictMode: its dev-only double mount would start and stop keryx twice.
createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
);
