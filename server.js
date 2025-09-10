import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";
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

  const text = JSON.stringify(json);
  const urls = [...text.matchAll(/https?:\/\/[^\s"']+/g)].map((m) => m[0]);
  const candidates = urls.filter((u) => /\.(mp4|m3u8)(\?|$)/i.test(u));
  if (!candidates.length) return reply.status(404).send("No video found");

  const chosen = candidates[0];
  app.log.info(`Chosen: ${chosen}`);

  const outPath = join(os.tmpdir(), `bsky_${Date.now()}.mp4`);

  if (chosen.endsWith(".m3u8")) {
    return new Promise((resolve) => {
      const ffmpeg = spawn("ffmpeg", [
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-protocol_whitelist", "file,http,https,tcp,tls",
        "-headers", "User-Agent: bsky-downloader/1.0",
        "-i", chosen,
        "-c", "copy",
        outPath,
      ]);

      ffmpeg.stderr.on("data", (data) => {
        app.log.error("FFmpeg:", data.toString());
      });

      ffmpeg.on("close", (code) => {
        if (code !== 0) {
          reply.status(500).send("ffmpeg failed, check logs");
          return resolve();
        }
        reply.header("Content-Type", "video/mp4");
        reply.header("Content-Disposition", 'attachment; filename="video.mp4"');
        const stream = fs.createReadStream(outPath);
        stream.pipe(reply.raw);
        stream.on("close", () => fs.unlink(outPath, () => {}));
        resolve();
      });
    });
  } else {
    try {
      const res = await fetch(chosen);
      reply.header("Content-Type", "video/mp4");
      reply.header("Content-Disposition", 'attachment; filename="video.mp4"');
      res.body.on("error", (err) => {
        app.log.error("Direct fetch error:", err);
        reply.raw.end();
      });
      res.body.pipe(reply.raw);
    } catch (e) {
      app.log.error("Direct download failed:", e);
      reply.status(500).send("Direct download failed");
    }
  }
});

// Start server (Render needs process.env.PORT)
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
