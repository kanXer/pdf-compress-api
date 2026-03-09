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

// Optimization: Sirf pehle page par check karke quality dhoondna
async function getOptimalQuality(sampleImagePath, targetPerPage) {
    let low = 5, high = 95, bestQ = 60;
    for (let i = 0; i < 5; i++) { // Sirf 5 test ek single page par
        let q = Math.floor((low + high) / 2);
        const buffer = await sharp(sampleImagePath).jpeg({ quality: q, mozjpeg: true }).toBuffer();
        const size = buffer.length / 1024;
        if (size > targetPerPage) high = q - 1;
        else { low = q + 1; bestQ = q; }
    }
    return bestQ;
}

async function fastExtremeCompress(inputPath, targetKB) {
    const sessionID = crypto.randomUUID();
    const sessionDir = path.join("temp_images", sessionID);
    fs.mkdirSync(sessionDir);

    try {
        // 1. PDF ko images mein badlo
        await execPromise(`pdftoppm -jpeg -r 150 "${inputPath}" "${sessionDir}/page"`);
        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jpg")).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
        
        const totalPages = files.length;
        const targetPerPage = (targetKB * 0.9) / totalPages; // 10% safety margin

        // 2. Sample page par best quality dhoondo (Fast)
        const bestQ = await getOptimalQuality(path.join(sessionDir, files[0]), targetPerPage);

        // 3. Parallel Processing (Sare pages ek saath)
        const pdf = await PDFDocument.create();
        const pageBuffers = await Promise.all(files.map(f => 
            sharp(path.join(sessionDir, f)).jpeg({ quality: bestQ, mozjpeg: true }).toBuffer()
        ));

        for (const b of pageBuffers) {
            const img = await pdf.embedJpg(b);
            pdf.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        }

        const finalPath = `outputs/fast_${sessionID}.pdf`;
        fs.writeFileSync(finalPath, await pdf.save());
        return finalPath;
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

app.post("/compress-pdf", upload.single("file"), async (req, res) => {
    try {
        const target = parseInt(req.body.target);
        const result = await fastExtremeCompress(req.file.path, target);
        res.download(result);
    } catch (e) {
        res.status(500).send("Error: " + e.message);
    }
});

app.listen(3000, () => console.log("Engine flying at 3000..."));
