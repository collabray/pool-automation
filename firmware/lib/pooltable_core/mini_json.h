#pragma once
// Small strict JSON reader (objects, arrays, strings with escapes, numbers, bool, null). Enough for the server's sync response.
#include <cstdint>
#include <cstdlib>
#include <string>
#include <utility>
#include <vector>

namespace pt {
struct JsonValue {
  enum Type { Null, Bool, Number, String, Array, Object } type = Null;
  bool b = false; double num = 0; bool isInt = false; int64_t i = 0; std::string s;
  std::vector<JsonValue> arr; std::vector<std::pair<std::string, JsonValue>> obj;
  const JsonValue* get(const std::string& k) const { for (auto& p : obj) if (p.first == k) return &p.second; return nullptr; }
  std::string str(const std::string& k, const std::string& d = "") const { auto* v = get(k); return v && v->type == String ? v->s : d; }
  int64_t integer(const std::string& k, int64_t d = 0) const { auto* v = get(k); return v && v->type == Number ? (v->isInt ? v->i : (int64_t)v->num) : d; }
  bool boolean(const std::string& k, bool d = false) const { auto* v = get(k); return v && v->type == Bool ? v->b : d; }
};

class JsonParser {
 public:
  static bool parse(const std::string& text, JsonValue& out) { JsonParser p(text); p.ws(); if (!p.value(out, 0)) return false; p.ws(); return p.pos == p.t.size(); }
 private:
  const std::string& t; size_t pos = 0;
  explicit JsonParser(const std::string& s) : t(s) {}
  void ws() { while (pos < t.size() && (t[pos] == ' ' || t[pos] == '\n' || t[pos] == '\r' || t[pos] == '\t')) pos++; }
  bool lit(const char* w) { size_t n = 0; while (w[n]) n++; if (t.compare(pos, n, w) != 0) return false; pos += n; return true; }
  bool value(JsonValue& v, int depth) {
    if (depth > 12 || pos >= t.size()) return false;
    char c = t[pos];
    if (c == '{') return object(v, depth);
    if (c == '[') return array(v, depth);
    if (c == '"') { v.type = JsonValue::String; return string(v.s); }
    if (c == 't') { v.type = JsonValue::Bool; v.b = true; return lit("true"); }
    if (c == 'f') { v.type = JsonValue::Bool; v.b = false; return lit("false"); }
    if (c == 'n') { v.type = JsonValue::Null; return lit("null"); }
    return number(v);
  }
  bool number(JsonValue& v) {
    size_t st = pos; bool frac = false;
    if (pos < t.size() && t[pos] == '-') pos++;
    size_t digits = 0; while (pos < t.size() && t[pos] >= '0' && t[pos] <= '9') { pos++; digits++; }
    if (!digits) return false;
    if (pos < t.size() && (t[pos] == '.' || t[pos] == 'e' || t[pos] == 'E')) { frac = true; pos++; while (pos < t.size() && ((t[pos] >= '0' && t[pos] <= '9') || t[pos] == '+' || t[pos] == '-' || t[pos] == 'e' || t[pos] == 'E')) pos++; }
    std::string n = t.substr(st, pos - st); v.type = JsonValue::Number; v.num = strtod(n.c_str(), nullptr); v.isInt = !frac; if (!frac) v.i = strtoll(n.c_str(), nullptr, 10);
    return true;
  }
  bool string(std::string& out) {
    pos++; out.clear();
    while (pos < t.size()) {
      char c = t[pos++];
      if (c == '"') return true;
      if (c == '\\') {
        if (pos >= t.size()) return false; char e = t[pos++];
        switch (e) { case 'n': out += '\n'; break; case 't': out += '\t'; break; case 'r': out += '\r'; break; case 'b': out += '\b'; break; case 'f': out += '\f'; break; case '/': case '\\': case '"': out += e; break;
          case 'u': { if (pos + 4 > t.size()) return false; unsigned cp = (unsigned)strtoul(t.substr(pos, 4).c_str(), nullptr, 16); pos += 4; if (cp < 0x80) out += (char)cp; else if (cp < 0x800) { out += (char)(0xC0 | cp >> 6); out += (char)(0x80 | (cp & 63)); } else { out += (char)(0xE0 | cp >> 12); out += (char)(0x80 | ((cp >> 6) & 63)); out += (char)(0x80 | (cp & 63)); } break; }
          default: return false; }
      } else if ((unsigned char)c < 0x20) return false; else out += c;
    }
    return false;
  }
  bool array(JsonValue& v, int d) {
    v.type = JsonValue::Array; pos++; ws(); if (pos < t.size() && t[pos] == ']') { pos++; return true; }
    for (;;) { JsonValue e; ws(); if (!value(e, d + 1)) return false; v.arr.push_back(std::move(e)); ws(); if (pos >= t.size()) return false; if (t[pos] == ',') { pos++; continue; } if (t[pos] == ']') { pos++; return true; } return false; }
  }
  bool object(JsonValue& v, int d) {
    v.type = JsonValue::Object; pos++; ws(); if (pos < t.size() && t[pos] == '}') { pos++; return true; }
    for (;;) { ws(); if (pos >= t.size() || t[pos] != '"') return false; std::string k; if (!string(k)) return false; ws(); if (pos >= t.size() || t[pos] != ':') return false; pos++; ws();
      JsonValue e; if (!value(e, d + 1)) return false; v.obj.emplace_back(std::move(k), std::move(e)); ws(); if (pos >= t.size()) return false; if (t[pos] == ',') { pos++; continue; } if (t[pos] == '}') { pos++; return true; } return false; }
  }
};
}  // namespace pt
