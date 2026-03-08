import express from "express";
import multer from "multer";
import fs from "fs";
import sharp from "sharp";
import { execSync } from "child_process";
import { PDFDocument } from "pdf-lib";
import path from "path";
import crypto from "crypto"; // For unique session IDs

const app = express();
const upload = multer({ dest: "uploads/" });

// Ensure necessary directories exist
["uploads", "outputs", "temp_images"].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

async function smartCompress(inputPath, targetKB) {
    const sessionID = crypto.randomUUID();
    const sessionDir = path.join("temp_images", sessionID);
    fs.mkdirSync(sessionDir);

    try {
        // Step 1: Extract PDF pages as images at 150 DPI
        execSync(`pdftoppm -jpeg -r 150 "${inputPath}" "${sessionDir}/page"`);
        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jpg")).sort();

        let minQ = 5;
        let maxQ = 90;
        let currentWidth = 1100; 
        let bestBytes = null;
        let bestDiff = Infinity;

        // Binary Search Logic
        for (let i = 0; i < 8; i++) {
            const q = Math.floor((minQ + maxQ) / 2);
            const pdf = await PDFDocument.create();

            for (const f of files) {
                const imgBuffer = fs.readFileSync(path.join(sessionDir, f));
                const compressed = await sharp(imgBuffer)
                    .resize({ width: Math.floor(currentWidth) })
                    .jpeg({ quality: q, mozjpeg: true })
                    .toBuffer();

                const img = await pdf.embedJpg(compressed);
                const page = pdf.addPage([img.width, img.height]);
                page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
            }

            const pdfBytes = await pdf.save();
            const currentSizeKB = pdfBytes.length / 1024; // Faster than writing to disk
            const diff = Math.abs(currentSizeKB - targetKB);

            if (diff < bestDiff) {
                bestDiff = diff;
                bestBytes = pdfBytes;
            }

            // Target Logic: Stop if within 5% tolerance
            if (diff < (targetKB * 0.05)) break;

            if (currentSizeKB > targetKB) {
                maxQ = q - 1;
                // If quality is already low but size is high, drop resolution
                if (q < 15) {
                    currentWidth *= 0.8;
                    minQ = 10; maxQ = 80; 
                }
            } else {
                minQ = q + 1;
            }
        }

        const outPath = path.join("outputs", `final_${sessionID}.pdf`);
        fs.writeFileSync(outPath, bestBytes);
        return outPath;

    } finally {
        // Always clean up the extracted images
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

app.post("/compress", upload.single("file"), async (req, res) => {
    try {
        const target = parseInt(req.body.target);
        if (!target || !req.file) return res.status(400).send("Target and File required");

        const resultPath = await smartCompress(req.file.path, target);
        
        res.download(resultPath, () => {
            // Final cleanup: Delete uploaded and generated files
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
        });
    } catch (e) {
        console.error(e);
        res.status(500).send("Compression error: " + e.message);
    }
});

app.listen(3000, () => console.log("PDF Engine Online on Port 3000"));
