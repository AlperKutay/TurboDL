import { createRoot } from "react-dom/client";
import "./styles.css";
import { MainWindow } from "./views/MainWindow";

createRoot(document.getElementById("root")!).render(<MainWindow />);
