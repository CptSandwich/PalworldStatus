import Dockerode from "dockerode";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

export interface PalworldContainer {
  id: string;       // Docker container ID (changes on recreation)
  serverId: string; // Stable ID: label palworld-status.server-id ?? container name
  name: string;
  status: "running" | "stopped" | "starting";
  restPort: number;
  restPassword: string;
  allowStart: boolean;
  idleShutdownMinutes: number;
  gamePort: number | null;
}

const LABEL_PREFIX = "palworld-status";

export async function discoverPalworldContainers(): Promise<PalworldContainer[]> {
  const containers = await docker.listContainers({ all: true });

  const palworld = containers.filter(
    (c) => c.Labels?.[`${LABEL_PREFIX}.enabled`] === "true"
  );

  return palworld.map((c) => {
    const labels = c.Labels ?? {};
    const rawName = c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12);
    const state = c.State.toLowerCase();

    let status: PalworldContainer["status"] = "stopped";
    if (state === "running") status = "running";
    else if (state === "restarting" || state === "created") status = "starting";

    // Find the host-mapped game port (8211/udp is the default Palworld game port)
    let gamePort: number | null = null;
    for (const binding of c.Ports ?? []) {
      if (binding.PrivatePort === 8211 && binding.PublicPort) {
        gamePort = binding.PublicPort;
        break;
      }
    }
    // Fallback: look for any UDP port binding
    if (!gamePort) {
      for (const binding of c.Ports ?? []) {
        if (binding.Type === "udp" && binding.PublicPort) {
          gamePort = binding.PublicPort;
          break;
        }
      }
    }

    return {
      id: c.Id,
      serverId: labels[`${LABEL_PREFIX}.server-id`] ?? rawName,
      name: rawName,
      status,
      restPort: parseInt(labels[`${LABEL_PREFIX}.rest-port`] ?? "8212", 10),
      restPassword: labels[`${LABEL_PREFIX}.rest-password`] ?? "",
      allowStart: labels[`${LABEL_PREFIX}.allow-start`] === "true",
      idleShutdownMinutes: parseInt(
        labels[`${LABEL_PREFIX}.idle-shutdown-minutes`] ?? "0",
        10
      ),
      gamePort,
    };
  });
}

export async function getContainerIP(containerId: string): Promise<string | null> {
  try {
    const info = await docker.getContainer(containerId).inspect();
    const networks = info.NetworkSettings?.Networks ?? {};
    const networkMode = info.HostConfig?.NetworkMode ?? "unknown";
    for (const [netName, net] of Object.entries(networks)) {
      if (net?.IPAddress) return net.IPAddress;
      console.warn(`[docker] getContainerIP ${containerId.slice(0, 12)} — network "${netName}" has no IPAddress (mode: ${networkMode})`);
    }
    if (Object.keys(networks).length === 0) {
      console.warn(`[docker] getContainerIP ${containerId.slice(0, 12)} — no networks attached (mode: ${networkMode})`);
    }
    return null;
  } catch (err) {
    console.warn(`[docker] getContainerIP ${containerId.slice(0, 12)} — inspect failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function startContainer(containerId: string): Promise<void> {
  await docker.getContainer(containerId).start();
}

export async function stopContainer(containerId: string): Promise<void> {
  await docker.getContainer(containerId).stop({ t: 30 });
}

export async function restartContainer(containerId: string): Promise<void> {
  await docker.getContainer(containerId).restart({ t: 30 });
}
