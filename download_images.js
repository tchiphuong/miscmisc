const fs = require("fs");
const https = require("https");
const path = require("path");
const url = require("url");

const hlsData = require("./hls.json");
const outputDir = path.join(__dirname, "iptv", "img");

// Create output directory if it doesn't exist
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// Function to download image
function downloadImage(imageUrl, outputPath) {
    return new Promise((resolve, reject) => {
        // Delete existing file if it exists
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }

        https
            .get(imageUrl, (response) => {
                if (response.statusCode === 200) {
                    const fileStream = fs.createWriteStream(outputPath);
                    response.pipe(fileStream);
                    fileStream.on("finish", () => {
                        fileStream.close();
                        resolve();
                    });
                } else {
                    reject(new Error(`Failed to download ${imageUrl}: ${response.statusCode}`));
                }
            })
            .on("error", (err) => {
                reject(err);
            });
    });
}

// Process all groups and channels
async function processImages() {
    const processedUrls = new Set();

    for (const group of hlsData) {
        for (const channel of group.channels) {
            if (channel.logo && !processedUrls.has(channel.logo)) {
                try {
                    const fileName = `${channel.id}.png`;
                    const outputPath = path.join(outputDir, fileName);

                    console.log(`Downloading: ${channel.logo}`);
                    await downloadImage(channel.logo, outputPath);
                    console.log(`Saved to: ${outputPath}`);

                    processedUrls.add(channel.logo);
                } catch (error) {
                    console.error(`Error downloading ${channel.logo}:`, error.message);
                }
            }
        }
    }
}

// Run the download process
processImages()
    .then(() => {
        console.log("Download complete!");
    })
    .catch((error) => {
        console.error("Error:", error);
    });

//RUN: node download_images.js
