import json

import pytest
from interlink_support.knowledge.documents import extract_text


def test_text_and_markdown_are_utf8():
    assert extract_text("x.md", "Xin chào InterLink".encode()) == "Xin chào InterLink"


def test_json_is_normalized_without_losing_unicode():
    out = extract_text("x.json", json.dumps({"message": "Quên ID"}, ensure_ascii=False).encode())
    assert "Quên ID" in out


def test_csv_turns_rows_into_searchable_lines():
    out = extract_text("x.csv", b"topic,answer\nforgot id,recover in app\n")
    assert "forgot id | recover in app" in out


def test_unsupported_file_is_rejected():
    with pytest.raises(ValueError, match="định dạng chưa hỗ trợ"):
        extract_text("malware.exe", b"x")
