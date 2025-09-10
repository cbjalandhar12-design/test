import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
import os from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });

// Serve frontend
app.register(fastifyStatic, {
  root: join(__dirname, "public"),
  prefix: "/",
});

// Helper: make Bluesky API URL
function getApiUrl(postUrl) {
  const m = postUrl.match(/profile\/([^/]+)\/post\/([^/?#]+)/);
  if (!m) return null;
  const user = m[1];
  const postid = m[2];
  return `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://${user}/app.bsky.feed.post/${postid}`;
}

// Helper: download file
async function downloadSegment(url, dest) {
  const res = await fetch(url, {
    headers: { "User-Agent": "bsky-downloader/1.0" },
  });
  if (!res.ok) throw new Error(`Failed segment ${url}`);
  const file = fs.createWriteStream(dest);
  return new Promise((resolve, reject) => {
    res.body.pipe(file);
    res.body.on("error", reject);
    file.on("finish", resolve);
  });
}

// Download route
app.get("/download", async (req, reply) => {
  const postUrl = req.query.url;
  if (!postUrl) return reply.status(400).send("Missing url");

  const apiUrl = getApiUrl(postUrl);
  if (!apiUrl) return reply.status(400).send("Invalid Bluesky URL");

  let json;
  try {
    const res = await fetch(apiUrl, {
      headers: { "User-Agent": "bsky-downloader/1.0" },
    });
    json = await res.json();
  } catch (e) {
    app.log.error(e);
    return reply.status(500).send("Failed to fetch API");
  }

  // find video URLs
  const text = JSON.stringify(json);
  const urls = [...text.matchAll(/https?:\/\/[^\s"']+/g)].map((m) => m[0]);
  const candidates = urls.filter((u) => /\.(mp4|m3u8)(\?|$)/i.test(u));
  if (!candidates.length) return reply.status(404).send("No video found");

  const chosen = candidates[0];
  app.log.info(`Chosen: ${chosen}`);

  // If MP4 direct link
  if (chosen.endsWith(".mp4")) {
    try {
      const res = await fetch(chosen);
      reply.header("Content-Type", "video/mp4");
      reply.header("Content-Disposition", 'attachment; filename="video.mp4"');
      res.body.pipe(reply.raw);
    } catch (e) {
      app.log.error("Direct download failed:", e);
      reply.status(500).send("Direct download failed");
    }
    return;
  }

  // If HLS (.m3u8)
  try {
    const res = await fetch(chosen, {
      headers: { "User-Agent": "bsky-downloader/1.0" },
    });
    if (!res.ok) throw new Error("Failed to fetch playlist");
    const playlist = await res.text();

    // parse segments
    const baseUrl = chosen.substring(0, chosen.lastIndexOf("/") + 1);
    const segments = playlist
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => (line.startsWith("http") ? line : baseUrl + line));

    if (!segments.length) {
      return reply.status(404).send("No segments found in playlist");
    }

    app.log.info(`Found ${segments.length} segments`);

    const tmpFile = join(os.tmpdir(), `bsky_${Date.now()}.mp4`);
    const out = fs.createWriteStream(tmpFile);

    for (let i = 0; i < segments.length; i++) {
      const segUrl = segments[i];
      app.log.info(`Downloading segment ${i + 1}/${segments.length}`);
      try {
        const segRes = await fetch(segUrl, {
          headers: { "User-Agent": "bsky-downloader/1.0" },
        });
        if (!segRes.ok) throw new Error(`Failed segment ${i}`);
        const buffer = await segRes.arrayBuffer();
        out.write(Buffer.from(buffer));
      } catch (err) {
        app.log.error("Segment download failed:", err);
        out.close();
        return reply.status(500).send("Segment download failed");
      }
    }

    out.end(() => {
      reply.header("Content-Type", "video/mp4");
      reply.header("Content-Disposition", 'attachment; filename="video.mp4"');
      const stream = fs.createReadStream(tmpFile);
      stream.pipe(reply.raw);
      stream.on("close", () => fs.unlink(tmpFile, () => {}));
    });
  } catch (err) {
    app.log.error("HLS download failed:", err);
    reply.status(500).send("HLS download failed");
  }
});

// Start server
const start = async () => {
  try {
    await app.listen({ port: process.env.PORT || 3000, host: "0.0.0.0" });
    app.log.info("Server running on port " + (process.env.PORT || 3000));
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};
start();
