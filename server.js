import express from "express";
import multer from "multer";
import fs from "fs";
import sharp from "sharp";
import { exec } from "child_process";
import { PDFDocument } from "pdf-lib";
import path from "path";
import crypto from "crypto";
import cors from "cors";
import { promisify } from "util";

const execPromise = promisify(exec);
const app = express();
app.use(cors());
const upload = multer({ dest: "uploads/" });

["uploads", "outputs", "temp_images"].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d));

/**
 * STRATEGY 1: Ghostscript (Efficient & preserves text)
 */
async function tryGhostscript(input, targetKB) {
    const out = `outputs/gs_${Date.now()}.pdf`;
    // 'screen' profile sabse aggressive compression karta hai (72 DPI)
    const cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${out}" "${input}"`;
    try {
        await execPromise(cmd);
        const size = fs.statSync(out).size / 1024;
        return { path: out, size, success: size <= targetKB * 1.1 };
    } catch (e) {
        return { success: false };
    }
}

/**
 * STRATEGY 2: Adaptive Rasterization (When GS fails)
 */
async function extremeRasterCompress(inputPath, targetKB) {
    const sessionID = crypto.randomUUID();
    const sessionDir = path.join("temp_images", sessionID);
    fs.mkdirSync(sessionDir);

    try {
        // Target ke hisaab se DPI set karo (50KB ke liye 72 DPI kaafi hai)
        const dpi = targetKB < 100 ? 72 : 120;
        await execPromise(`pdftoppm -jpeg -r ${dpi} "${inputPath}" "${sessionDir}/page"`);
        
        const files = fs.readdirSync(sessionDir)
            .filter(f => f.endsWith(".jpg"))
            .sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
        
        const totalPages = files.length;
        const overhead = (totalPages * 1.2) + 10;
        const targetPerPage = (targetKB - overhead) / totalPages;

        // Black & White if target is very low
        const useGrayscale = targetKB < 100;

        const pdf = await PDFDocument.create();
        const pageBuffers = await Promise.all(files.map(async (f) => {
            let s = sharp(path.join(sessionDir, f)).rotate().withMetadata(false);
            if (useGrayscale) s = s.grayscale();
            
            // Start with very low quality if target is tight
            return s.jpeg({ quality: 30, mozjpeg: true }).toBuffer();
        }));

        for (const b of pageBuffers) {
            const img = await pdf.embedJpg(b);
            pdf.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        }

        const finalBytes = await pdf.save();
        const finalPath = `outputs/ext_${sessionID}.pdf`;
        fs.writeFileSync(finalPath, finalBytes);
        return { path: finalPath, size: finalBytes.length / 1024 };
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

app.post("/compress-pdf", upload.single("file"), async (req, res) => {
    try {
        const input = req.file.path;
        const target = parseInt(req.body.target);
        const originalSize = fs.statSync(input).size / 1024;

        console.log(`Processing: ${originalSize}KB -> Target: ${target}KB`);

        // Step 1: Try Ghostscript (Best for Text)
        let result = await tryGhostscript(input, target);

        // Step 2: If GS not enough, try Extreme Rasterization
        if (!result.success || result.size > target) {
            console.log("Ghostscript insufficient, trying Extreme Rasterization...");
            const rasterResult = await extremeRasterCompress(input, target);
            
            // Pick whichever is smaller
            if (result.path && fs.existsSync(result.path) && result.size < rasterResult.size) {
                // Keep GS result
            } else {
                result = rasterResult;
            }
        }

        // Final Safety: Agar abhi bhi bada hai original se, toh error ya original bhej do
        if (result.size > originalSize) {
            console.log("Warning: Compression increased size. Sending original.");
            return res.download(input);
        }

        res.download(result.path);

    } catch (e) {
        res.status(500).send("Error: " + e.message);
    }
});

app.listen(3000, () => console.log("Precision Engine running on 3000..."));
