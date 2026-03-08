import express from "express"
import multer from "multer"
import fs from "fs"
import sharp from "sharp"
import { execSync } from "child_process"
import { PDFDocument } from "pdf-lib"

const app = express()
const upload = multer({ dest:"uploads/" })

function sizeKB(path){
 return fs.statSync(path).size / 1024
}

function cleanTemp(){

 if(!fs.existsSync("temp_images")) fs.mkdirSync("temp_images")

 fs.readdirSync("temp_images").forEach(f=>{
  fs.unlinkSync(`temp_images/${f}`)
 })

}

// -------- Ghostscript Compression --------

function ghostCompress(input,output){

 execSync(`gs -sDEVICE=pdfwrite \
 -dCompatibilityLevel=1.4 \
 -dPDFSETTINGS=/screen \
 -dNOPAUSE -dQUIET -dBATCH \
 -sOutputFile=${output} ${input}`)

}

// -------- Extreme Binary Search Compression --------

async function extremeCompress(input,target){

 cleanTemp()

 execSync(`pdftoppm -jpeg -r 72 ${input} temp_images/page`)

 const files = fs.readdirSync("temp_images")
   .filter(f=>f.endsWith(".jpg") || f.endsWith(".jpeg"))
   .sort()

 if(files.length === 0){
  throw new Error("Image extraction failed")
 }

 let minQ = 10
 let maxQ = 90

 let bestFile = null
 let bestDiff = Infinity

 for(let i=0;i<8;i++){

  const q = Math.floor((minQ + maxQ)/2)

  const pdf = await PDFDocument.create()

  for(const f of files){

   const imgBuffer = fs.readFileSync(`temp_images/${f}`)

   const compressed = await sharp(imgBuffer)
     .resize({ width:900 })
     .jpeg({ quality:q })
     .toBuffer()

   const img = await pdf.embedJpg(compressed)

   const page = pdf.addPage([img.width,img.height])

   page.drawImage(img,{
    x:0,
    y:0,
    width:img.width,
    height:img.height
   })

  }

  const bytes = await pdf.save()

  const out = `outputs/out-${Date.now()}-${q}.pdf`

  fs.writeFileSync(out,bytes)

  const size = sizeKB(out)

  if(size < 5) continue

  const diff = Math.abs(size-target)

  if(diff < bestDiff){
   bestDiff = diff
   bestFile = out
  }

  if(size > target){
   maxQ = q - 1
  }else{
   minQ = q + 1
  }

 }

 return bestFile

}

// -------- API --------

app.post("/compress",upload.single("file"),async(req,res)=>{

 try{

  const input = req.file.path

  const target = parseInt(req.body.target)

  if(!target) return res.status(400).send("Target size required")

  const original = sizeKB(input)

  let output

  if(original / target > 2){

   output = await extremeCompress(input,target)

  }else{

   output = `outputs/out-${Date.now()}.pdf`

   ghostCompress(input,output)

  }

  if(!output || !fs.existsSync(output)){
   return res.status(500).send("Compression failed")
  }

  res.download(output)

 }catch(e){

  console.error(e)

  res.status(500).send("Compression error")

 }

})

// -------- Status --------

app.get("/",(req,res)=>{
 res.send("Smart PDF Compressor running")
})

app.listen(3000,()=>{
 console.log("Server running")
})
