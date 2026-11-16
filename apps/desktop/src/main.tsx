import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// No StrictMode: its dev-only double mount would start and stop keryx twice.
createRoot(document.getElementById("root")!).render(<App />);
