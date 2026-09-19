import { startPolling } from "./src/poller.js";
import { startServer } from "./src/server.js";

startServer(3001);
startPolling();
