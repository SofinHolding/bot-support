from pathlib import Path

from interlink_support.import_clean_source import workbook_units
from openpyxl import Workbook


def test_clean_workbook_maps_rows_to_distinct_support_units(tmp_path: Path) -> None:
    path = tmp_path / "clean.xlsx"
    wb = Workbook()
    ws = wb.active
    ws.title = "Noi dung V1"
    ws.append(["Tên", "Khách thường hỏi", "Nội dung"])
    ws.append(["Quên ID", "forgot id | quên id", "Self-service recovery steps"])
    ws.append(["Lỗi game", "game error", "Contact support"])
    wb.save(path)

    sheet, units = workbook_units(path)
    assert sheet == "Noi dung V1"
    assert [u.knowledge_key for u in units] == ["support.quen-id", "support.loi-game"]
    assert units[0].metadata["source_ref"] == "Sheet Noi dung V1, dòng 2"
    assert units[0].keywords == ["Quên ID", "forgot id", "quên id"]
    assert units[0].content == "Self-service recovery steps"
