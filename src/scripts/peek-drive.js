/**
 * Peek deeper into one artist's folder to see actual image files
 */
const { google } = require("googleapis");

async function peekDeep() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "./credentials/google-service-account.json",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });

  // Get first artist folder
  const topLevel = await drive.files.list({
    q: `'1k_ZNb3_e1WHUlnDSlkrGggrYTvYDMWhD' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
    fields: "files(id, name)",
    pageSize: 5,
  });

  for (const artist of topLevel.data.files.slice(0, 2)) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🎨 ARTIST: ${artist.name}`);
    console.log("=".repeat(60));

    // Get subfolders (Above/Below)
    const subs = await drive.files.list({
      q: `'${artist.id}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
      fields: "files(id, name)",
      pageSize: 10,
    });

    for (const sub of subs.data.files) {
      // Get actual images
      const images = await drive.files.list({
        q: `'${sub.id}' in parents and trashed = false`,
        fields: "files(id, name, mimeType, size)",
        pageSize: 10,
      });

      const realImages = images.data.files.filter(f => !f.name.startsWith("._"));
      console.log(`\n  📁 ${sub.name} (${realImages.length}+ images):`);
      
      realImages.slice(0, 5).forEach(f => {
        const sizeMB = f.size ? (parseInt(f.size) / 1024 / 1024).toFixed(1) + " MB" : "?";
        console.log(`      🖼️  ${f.name}  (${sizeMB})`);
      });
    }
  }

  // Also count total artist folders
  let totalFolders = 0;
  let pageToken = null;
  do {
    const r = await drive.files.list({
      q: `'1k_ZNb3_e1WHUlnDSlkrGggrYTvYDMWhD' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
      fields: "nextPageToken, files(id)",
      pageSize: 1000,
      pageToken,
    });
    totalFolders += r.data.files.length;
    pageToken = r.data.nextPageToken;
  } while (pageToken);

  console.log(`\n\n📊 TOTAL ARTIST FOLDERS: ${totalFolders}`);
}

peekDeep().catch(console.error);
