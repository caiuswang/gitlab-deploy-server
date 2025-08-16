import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createApp } from "./app";
import { SERVER_PORT } from "./config";
import deployRouter from "./routes/deploy";
import projectRouter from "./routes/projects";
import { BroadCastService, GitLabDeployService } from "./services/deploy";
import { QueryService } from "./services/query";

// WebSocket server setup
const wss = new WebSocketServer({ noServer: true }); // Use `noServer` to manually handle WebSocket upgrades

// Pass broadcast function to deploy service
const deployService = new GitLabDeployService(new BroadCastService(wss));
const app = createApp(deployService);
const server = createServer(app); // Create an HTTP server
const queryService = new QueryService();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "", `http://localhost:${SERVER_PORT}`);
  const endpoint = url.pathname;

  if (endpoint.startsWith("/ws/deploy/")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy(); // Destroy the socket if the endpoint is not a WebSocket endpoint
  }
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", `http://localhost:${SERVER_PORT}`);
  const endpoint = url.pathname;

  console.log(`WebSocket client connected to endpoint: ${endpoint}`);

  const deployMatch = endpoint.match(/^\/ws\/deploy\/(\d+)$/);
  if (deployMatch) {
    const deployId = Number(deployMatch[1]);
    handleDeployWebSocket(ws, deployId);
  } else {
    ws.send(JSON.stringify({ error: "Unknown endpoint" }));
    ws.close();
  }

  ws.on("close", () => {
    console.log(`WebSocket client disconnected from endpoint: ${endpoint}`);
  });
});

// Broadcast function for deploy updates
function broadcastDeployUpdate(deployId: number, event: any) {
  const message = JSON.stringify(event);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      const url = new URL(client.url || "", `http://localhost:${SERVER_PORT}`);
      const endpoint = url.pathname;
      if (endpoint === `/ws/deploy/${deployId}`) {
        client.send(message);
      }
    }
  });
}

// Handle deploy-specific WebSocket connections
function handleDeployWebSocket(ws: WebSocket, deployId: number) {
  console.log(`Listening for changes to deploy ID: ${deployId}`);
  ws.send(JSON.stringify({ type: "connected", message: `Listening for deploy ID: ${deployId}` }));

  // Simulate listening for deploy changes (replace with actual event subscription logic)
  const interval = setInterval(async () => {
    try {
      const fullDeployInfo = await queryService.getDeployDetail(deployId);
      if (fullDeployInfo) {
        ws.send(JSON.stringify({ type: "deploy_update", deploy: fullDeployInfo }));
      }
    } catch (error) {
      const errorMessage =
        typeof error === "object" && error !== null && "message" in error
          ? (error as { message?: string }).message
          : String(error);
      ws.send(JSON.stringify({ error: `Failed to fetch deploy details: ${errorMessage}` }));
    }
  }, 5000); // Poll every 5 seconds (replace with event-driven updates if possible)

  ws.on("close", () => {
    clearInterval(interval);
    console.log(`Stopped listening for changes to deploy ID: ${deployId}`);
  });
}

// Start server
server.listen(SERVER_PORT, () => {
  console.log(`Server and WebSocket listening on port ${SERVER_PORT}`);
});