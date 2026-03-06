import Dockerode from "dockerode";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

export interface PalworldContainer {
  id: string;
  name: string;
  displayName: string;
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
      name: rawName,
      displayName: labels[`${LABEL_PREFIX}.name`] ?? rawName,
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
    for (const net of Object.values(networks)) {
      if (net?.IPAddress) return net.IPAddress;
    }
    return null;
  } catch {
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
