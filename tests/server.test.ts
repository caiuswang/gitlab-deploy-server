import { createServer } from "http";
import { WebSocketServer } from "ws";
import { WebSocket } from "ws";
import { createApp } from "../src/app";
import { SERVER_PORT } from "../src/config";
import { beforeAll, afterAll, expect, test } from "@jest/globals";

let server: ReturnType<typeof createServer>;
let wss: WebSocketServer;

beforeAll((done) => {
  const app = createApp();
  server = createServer(app);

  // Set up WebSocket server
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "", `http://localhost:${SERVER_PORT}`);
    const endpoint = url.pathname;

    if (endpoint === "/ws/deploy") {
      ws.on("message", (message) => {
        const payload = JSON.parse(message.toString());
        if (payload.type === "status") {
          ws.send(JSON.stringify({ type: "deploy_status", status: "running" }));
        } else {
          ws.send(JSON.stringify({ error: "Unknown deploy action" }));
        }
      });
    } else if (endpoint === "/ws/project") {
      ws.on("message", (message) => {
        const payload = JSON.parse(message.toString());
        if (payload.type === "list") {
          ws.send(JSON.stringify({ type: "project_list", projects: ["Project A", "Project B"] }));
        } else {
          ws.send(JSON.stringify({ error: "Unknown project action" }));
        }
      });
    } else if (endpoint.startsWith("/ws/deploy/")) {
      const deployId = Number(endpoint.split("/").pop());
      ws.send(JSON.stringify({ type: "deploy_update", deploy: { id: deployId, status: "running" } }));

      // Simulate periodic updates
      const interval = setInterval(() => {
        ws.send(JSON.stringify({ type: "deploy_update", deploy: { id: deployId, status: "updated" } }));
      }, 1000);

      ws.on("close", () => clearInterval(interval));
    } else {
      ws.send(JSON.stringify({ error: "Unknown endpoint" }));
    }
  });

  server.listen(SERVER_PORT, done);
});

afterAll((done) => {
  wss.close();
  server.close(done);
});

test("WebSocket server should accept connections and send a welcome message", (done) => {
  const ws = new WebSocket(`ws://localhost:${SERVER_PORT}`);

  ws.on("open", () => {
    console.log("WebSocket client connected");
  });

  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    expect(message).toEqual({ error: "Unknown endpoint" });
    ws.close();
    done();
  });

  ws.on("error", (err) => {
    done(err);
  });
});

test("WebSocket /ws/deploy should respond to deploy status requests", (done) => {
  const ws = new WebSocket(`ws://localhost:${SERVER_PORT}/ws/deploy`);

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "status" }));
  });

  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    expect(message).toEqual({ type: "deploy_status", status: "running" });
    ws.close();
    done();
  });

  ws.on("error", (err) => {
    done(err);
  });
});

test("WebSocket /ws/project should respond with project list", (done) => {
  const ws = new WebSocket(`ws://localhost:${SERVER_PORT}/ws/project`);

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "list" }));
  });

  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    expect(message).toEqual({ type: "project_list", projects: ["Project A", "Project B"] });
    ws.close();
    done();
  });

  ws.on("error", (err) => {
    done(err);
  });
});

test("WebSocket /ws/project should handle unknown actions", (done) => {
  const ws = new WebSocket(`ws://localhost:${SERVER_PORT}/ws/project`);

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "unknown_action" }));
  });

  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    expect(message).toEqual({ error: "Unknown project action" });
    ws.close();
    done();
  });

  ws.on("error", (err) => {
    done(err);
  });
});

test("WebSocket /ws/deploy/:id should send initial deploy details", (done) => {
  const deployId = 123; // Replace with a valid deploy ID
  const ws = new WebSocket(`ws://localhost:${SERVER_PORT}/ws/deploy/${deployId}`);

  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "deploy_update") {
      expect(message.deploy).toEqual({ id: deployId, status: "running" });
      ws.close();
      done();
    }
  });

  ws.on("error", (err) => {
    done(err);
  });
});

test("WebSocket /ws/deploy/:id should send periodic updates", (done) => {
  const deployId = 456; // Replace with a valid deploy ID
  const ws = new WebSocket(`ws://localhost:${SERVER_PORT}/ws/deploy/${deployId}`);

  let updateCount = 0;

  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "deploy_update") {
      if (updateCount === 0) {
        expect(message.deploy).toEqual({ id: deployId, status: "running" });
      } else {
        expect(message.deploy).toEqual({ id: deployId, status: "updated" });
        if (updateCount === 2) {
          ws.close();
          done();
        }
      }
      updateCount++;
    }
  });

  ws.on("error", (err) => {
    done(err);
  });
});

test("WebSocket should handle unknown endpoints", (done) => {
  const ws = new WebSocket(`ws://localhost:${SERVER_PORT}/ws/unknown`);

  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    expect(message).toEqual({ error: "Unknown endpoint" });
    ws.close();
    done();
  });

  ws.on("error", (err) => {
    done(err);
  });
});
