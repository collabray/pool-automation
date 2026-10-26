#pragma once
// Minimal stand-in for the PlatformIO Unity test framework, so `tools/run-native-tests.sh` works without PlatformIO installed.
// The tests use only this API subset, which real Unity also provides.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
static int unity_failures = 0, unity_tests = 0, unity_current_failed = 0; static const char* unity_current = "";
#define UNITY_BEGIN() (unity_failures = 0, unity_tests = 0, 0)
#define UNITY_END() (printf("\n%d Tests %d Failures 0 Ignored\n%s\n", unity_tests, unity_failures, unity_failures ? "FAIL" : "OK"), unity_failures ? 1 : 0)
#define RUN_TEST(fn) do { unity_current = #fn; unity_current_failed = 0; unity_tests++; setUp(); fn(); tearDown(); printf("%s:%d:%s:%s\n", __FILE__, __LINE__, #fn, unity_current_failed ? "FAIL" : "PASS"); if (unity_current_failed) unity_failures++; } while (0)
#define UNITY_FAIL_(msg) do { printf("  FAILED at %s:%d in %s: %s\n", __FILE__, __LINE__, unity_current, msg); unity_current_failed = 1; return; } while (0)
#define TEST_ASSERT_TRUE(c) do { if (!(c)) UNITY_FAIL_("expected true: " #c); } while (0)
#define TEST_ASSERT_FALSE(c) do { if (c) UNITY_FAIL_("expected false: " #c); } while (0)
#define TEST_ASSERT_EQUAL_INT(e, a) do { long long _e = (long long)(e), _a = (long long)(a); if (_e != _a) { char b[160]; snprintf(b, sizeof b, "expected %lld got %lld (" #a ")", _e, _a); UNITY_FAIL_(b); } } while (0)
#define TEST_ASSERT_EQUAL_UINT32(e, a) TEST_ASSERT_EQUAL_INT(e, a)
#define TEST_ASSERT_EQUAL(e, a) TEST_ASSERT_EQUAL_INT(e, a)
#define TEST_ASSERT_EQUAL_STRING(e, a) do { std::string _e = (e), _a = (a); if (_e != _a) { std::string m = "expected '" + _e + "' got '" + _a + "'"; UNITY_FAIL_(m.c_str()); } } while (0)
#define TEST_ASSERT_EQUAL_MEMORY(e, a, n) do { if (memcmp((e), (a), (n)) != 0) UNITY_FAIL_("memory differs"); } while (0)
#define TEST_FAIL_MESSAGE(m) UNITY_FAIL_(m)
