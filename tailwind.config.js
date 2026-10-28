/** @type {import('tailwindcss').Config} */
export default {
content: [
  "./index.html",
  "./src/**/*.{js,ts,jsx,tsx}",
],
theme: {
  extend: {
    // Nâng cỡ chữ cho dễ đọc (bảng nhiều dữ liệu). Chỉ tăng font, giữ nguyên spacing.
    fontSize: {
      xs:   ['13px', { lineHeight: '18px' }],   // cũ 12px
      sm:   ['15px', { lineHeight: '22px' }],   // cũ 14px — body chính của bảng/chi tiết
      base: ['17px', { lineHeight: '26px' }],   // cũ 16px
      lg:   ['19px', { lineHeight: '28px' }],   // cũ 18px — số tổng kết
    },
  },
},
plugins: [],
}