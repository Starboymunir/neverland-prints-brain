/**
 * Quick debug: check folder structure and image access
 */
const { google } = require("googleapis");
const path = require("path");

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "./credentials/google-service-account.json",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });
  const ROOT = "1k_ZNb3_e1WHUlnDSlkrGggrYTvYDMWhD";

  // Get first 5 artist folders
  const foldersRes = await drive.files.list({
    q: `'${ROOT}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
    fields: "files(id, name)",
    pageSize: 5,
  });
  console.log("First 5 artist folders:", foldersRes.data.files.map(f => f.name));

  // Dive into the first one
  const first = foldersRes.data.files[0];
  console.log("\nLooking inside:", first.name, "(id:", first.id, ")");

  const subRes = await drive.files.list({
    q: `'${first.id}' in parents and trashed = false`,
    fields: "files(id, name, mimeType)",
    pageSize: 10,
  });
  console.log("Children:", subRes.data.files.map(f => `${f.name} (${f.mimeType})`));

  // Check ALL subfolders for images
  for (const sub of subRes.data.files.filter(f => f.mimeType === "application/vnd.google-apps.folder")) {
    console.log("\nLooking inside:", sub.name);
    const imgRes = await drive.files.list({
      q: `'${sub.id}' in parents and trashed = false`,
      fields: "files(id, name, mimeType, size)",
      pageSize: 5,
    });
    console.log(`  Count: ${imgRes.data.files.length} items`);
    console.log("  Files:", imgRes.data.files.map(f => `${f.name} (${f.mimeType}, ${f.size} bytes)`));
  }

  // Also check artist #2 and #3
  for (let i = 1; i < Math.min(3, foldersRes.data.files.length); i++) {
    const artist = foldersRes.data.files[i];
    console.log("\n--- Artist:", artist.name, "---");
    const s = await drive.files.list({
      q: `'${artist.id}' in parents and trashed = false`,
      fields: "files(id, name, mimeType)",
      pageSize: 10,
    });
    for (const sub of s.data.files.filter(f => f.mimeType === "application/vnd.google-apps.folder")) {
      const imgs = await drive.files.list({
        q: `'${sub.id}' in parents and trashed = false`,
        fields: "files(id, name, mimeType, size)",
        pageSize: 3,
      });
      console.log(`  ${sub.name}: ${imgs.data.files.length} files`);
      if (imgs.data.files.length > 0) {
        console.log("    Sample:", imgs.data.files[0].name, `(${imgs.data.files[0].size} bytes)`);
      }
    }
  }
}

main().catch(console.error);
