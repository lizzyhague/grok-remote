import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { CommandRunner } from "../commands/runner.ts";
import { ProjectCatalog } from "../projects/catalog.ts";
import { GrokSessionDisk } from "../sessions/disk.ts";
import { SessionLayoutStore } from "../sessions/layout-store.ts";
import { SessionService } from "../sessions/service.ts";
import { RemoteSessionStore } from "../sessions/store.ts";
import { TurnRuntime } from "../turns/runtime.ts";
import { RemoteWebSocketServer } from "./http-server.ts";
import { PresenceTracker } from "./presence.ts";
import { ProjectTaskLocks } from "./project-locks.ts";

const token = "smoke-token-value-must-be-32-chars";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "grok-remote-smoke-"));
  await mkdir(path.join(root, "demo"), { recursive: true });
  const configPath = path.join(root, "projects.json");
  await writeFile(configPath, JSON.stringify({
    roots: [{ id: "projects", path: root }],
  }));

  const projects = await ProjectCatalog.fromConfigFile(configPath);
  const disk = new GrokSessionDisk(path.join(root, "grok-home"));
  const store = new RemoteSessionStore(path.join(root, "state"));
  const layout = await SessionLayoutStore.open(path.join(root, "layout.json"));
  const sessions = new SessionService(projects, disk, store, layout);
  const presence = new PresenceTracker();
  const turns = new TurnRuntime({
    store,
    projects,
    presence,
    grokBin: "grok",
    spawnAgent: () => {
      throw new Error("smoke 不启动 Grok");
    },
  });
  const server = new RemoteWebSocketServer({
    token,
    services: {
      projects,
      sessions,
      turns,
      commands: new CommandRunner(turns, disk, store),
      locks: new ProjectTaskLocks(),
      presence,
    },
  });

  try {
    const address = await server.listen(0);
    const health = await fetch(`http://${address.host}:${address.port}/healthz`);
    if (health.status !== 200) {
      throw new Error("healthz 失败");
    }
    const page = await fetch(`http://${address.host}:${address.port}/`);
    if (!String(await page.text()).includes("Grok Remote")) {
      throw new Error("首页不是 Grok Remote");
    }
    const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`);
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "auth", requestId: "a", token }));
    const auth = JSON.parse(String((await once(socket, "message"))[0]));
    if (!auth.ok) throw new Error("认证失败");
    socket.send(JSON.stringify({ type: "projects.list", requestId: "p" }));
    const projectsMessage = JSON.parse(String((await once(socket, "message"))[0]));
    if (!projectsMessage.data?.projects?.length) throw new Error("项目列表为空");
    socket.close();
    console.log(`smoke ok http://${address.host}:${address.port}/`);
  } finally {
    await server.close();
    await turns.dispose();
    presence.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
