/**
 * Quick Drive explorer — see what's inside the client's folder
 */
const { google } = require("googleapis");

async function explore() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "./credentials/google-service-account.json",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });

  // List top-level items
  const topLevel = await drive.files.list({
    q: `'1k_ZNb3_e1WHUlnDSlkrGggrYTvYDMWhD' in parents and trashed = false`,
    fields: "nextPageToken, files(id, name, mimeType, size)",
    pageSize: 100,
  });

  const folders = topLevel.data.files.filter(f => f.mimeType === "application/vnd.google-apps.folder");
  const files = topLevel.data.files.filter(f => f.mimeType !== "application/vnd.google-apps.folder");

  console.log(`TOP LEVEL: ${folders.length} folders, ${files.length} files\n`);

  // Show first 20 folders (artist names)
  console.log("=== ARTIST FOLDERS (first 20) ===");
  folders.slice(0, 20).forEach(f => console.log(`  📁 ${f.name}`));
  if (folders.length > 20) console.log(`  ... and ${folders.length - 20} more\n`);

  // Peek inside the first 3 artist folders
  for (const folder of folders.slice(0, 3)) {
    const contents = await drive.files.list({
      q: `'${folder.id}' in parents and trashed = false`,
      fields: "files(id, name, mimeType, size)",
      pageSize: 10,
    });
    console.log(`\n📁 ${folder.name} (${contents.data.files.length}+ items):`);
    contents.data.files.slice(0, 5).forEach(f => {
      const sizeMB = f.size ? (parseInt(f.size) / 1024 / 1024).toFixed(1) + " MB" : "folder";
      console.log(`    ${f.mimeType === "application/vnd.google-apps.folder" ? "📁" : "🖼️"}  ${f.name}  (${sizeMB})`);
    });
  }

  // If there are loose files at top level
  if (files.length > 0) {
    console.log(`\n=== LOOSE FILES (first 5) ===`);
    files.slice(0, 5).forEach(f => console.log(`  🖼️ ${f.name} (${(parseInt(f.size || 0) / 1024 / 1024).toFixed(1)} MB)`));
  }
}

explore().catch(console.error);
