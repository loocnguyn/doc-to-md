# Doc → Markdown

Chuyển **PDF, DOCX, PPTX** sang **Markdown** ngay trong trình duyệt. File không được tải lên server nào, nên không giới hạn dung lượng và an toàn cho tài liệu riêng tư. Mục đích chính: đưa tài liệu dài cho LLM đọc mà tốn ít token hơn.

## Tính năng

**PDF** (pdf.js)
- Đoán heading theo cỡ chữ: gom các cỡ gần nhau thành một cấp, tối đa 3 cấp; bỏ qua số trang trí cỡ lớn.
- Dòng in đậm cùng cỡ thân bài, viết hoa hoặc đánh số mục ("1.2. …", "Chương 3 …") → heading.
- Bỏ header/footer lặp lại ở mép trang và số trang ("Trang 3 / 17", "Phần 4.1 · … 12").
- Ghép lại chữ giãn cách của slide ("C H Ư Ơ N G" → "CHƯƠNG") bằng tách âm tiết tiếng Việt.
- Gộp dòng thành đoạn, nhận gạch đầu dòng, cảnh báo khi PDF là bản scan.

**DOCX** (mammoth + turndown)
- Heading theo style của Word, danh sách, bảng → bảng markdown (GFM). Ảnh bị bỏ.

**PPTX** (đọc XML trực tiếp bằng JSZip)
- Thứ tự slide theo `presentation.xml`, shape sắp theo vị trí trên → dưới, trái → phải.
- Tiêu đề slide (placeholder, hoặc chữ ngắn cỡ lớn nhất), bullet theo cấp, bảng.
- Biểu đồ → bảng số liệu, SmartArt → danh sách, alt text của ảnh, ghi chú người thuyết trình.

Tuỳ chọn: chèn `<!-- trang N -->` / `<!-- slide N -->` để dễ trích dẫn vị trí.

## Chạy

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # ra thư mục dist/
```

Deploy: dự án Vite tĩnh, Vercel tự nhận (build `npm run build`, output `dist`).

## Giới hạn

- PDF scan (không có lớp chữ) cần OCR trước, ví dụ `ocrmypdf`.
- Không hỗ trợ `.doc` / `.ppt` đời cũ: lưu lại thành `.docx` / `.pptx`.
- Bảng trong PDF ra dạng dòng chữ, không dựng lại thành bảng.
- Chữ giãn cách lẫn tiếng Anh ("C A S E S T U D Y") được ghép liền, không tách từ.

## Tham khảo

- [opengovsg/pdf2md](https://github.com/opengovsg/pdf2md) (fork của jzillmann/pdf-to-markdown): nhận chữ đậm qua tên font của pdf.js, ý tưởng bỏ header/footer.
- [microsoft/markitdown](https://github.com/microsoft/markitdown): thứ tự shape theo vị trí, biểu đồ thành bảng, alt text ảnh trong PPTX.
