import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { parseRoute } from "./route";
import { MainWindow } from "./views/MainWindow";
import { MediaWindow } from "./views/MediaWindow";
import { NewDownloadWindow } from "./views/NewDownloadWindow";

function Root() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const route = parseRoute(hash);
  if (route.view === "new") return <NewDownloadWindow pendingId={route.id} />;
  if (route.view === "media") return <MediaWindow pendingId={route.id} />;
  return <MainWindow />;
}

createRoot(document.getElementById("root")!).render(<Root />);
