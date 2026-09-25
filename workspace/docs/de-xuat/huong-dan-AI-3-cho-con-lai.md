# Đề xuất sửa "Hướng dẫn AI làm việc": 3 chỗ còn mô tả hành vi cũ

Ba chỗ dưới đây chưa khớp với hệ thống hiện tại. Sửa đúng các dòng này, các phần khác giữ nguyên.

## 1. Mục 3 "Cách giao tiếp" — dòng "Lỗi kỹ thuật của bot"

**Hiện tại:**

> - **Lỗi kỹ thuật của bot:** không bao giờ hiển thị lỗi kỹ thuật cho khách; gửi câu "hệ thống đang bận" cố định **[CODE]**.

**Đề xuất:**

> - **Lỗi kỹ thuật của bot hoặc mất kết nối AI:** không bao giờ hiển thị lỗi kỹ thuật cho khách; gửi câu báo mất kết nối cố định bằng tiếng Anh **[CODE]**. Không gửi bất kỳ nội dung nào lấy từ kho khi AI chưa đánh giá.

## 2. Mục 5, bảng "Điều kiện giới hạn" — dòng "Hai câu trả lời đã duyệt đều có vẻ khớp"

**Hiện tại:**

> | Hai câu trả lời đã duyệt đều có vẻ khớp, không phân biệt được | Chuyển nhân viên, không chọn bừa |

**Đề xuất:**

> | Hai hoặc nhiều nội dung đã duyệt đều có vẻ khớp, không phân biệt được | Không chọn bừa. Nếu các nội dung đó không mâu thuẫn nhau: hỏi lại khách **một lần**, câu hỏi dựng từ nội dung đã duyệt của chính các trường hợp đó **[CODE]**; khách trả lời mà vẫn không rõ thì chuyển nhân viên **[CODE]**. Nếu các nội dung đang mâu thuẫn chưa được giải quyết: chuyển nhân viên **[CODE]** |

## 3. Bảng "Cách cập nhật để bot biết thêm"

**Hiện tại:**

> | Câu trả lời cho một tình huống, từ khoá, điều kiện, thông tin cần xin khi chuyển nhân viên | Kho tri thức → Template |
> | Kiến thức về dự án (tokenomics, whitepaper, chương trình...) | Kho tri thức → Tài liệu tri thức (tiếng Việt hoặc tiếng Anh) |

**Đề xuất** (gộp hai dòng thành một):

> | Câu trả lời cho các tình huống hỗ trợ và kiến thức về dự án (tokenomics, whitepaper, chương trình...) | Kho tri thức → **Thêm nội dung** (dán văn bản hoặc tệp; hệ thống tự phân loại, tự so với dữ liệu đang có). Sửa một nội dung có sẵn: mở nội dung đó → **Sửa nội dung** |

Các dòng còn lại của bảng giữ nguyên.
