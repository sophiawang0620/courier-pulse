import hashlib
import json
import unittest
from datetime import datetime, timezone

import kye_official


class KyeOfficialTests(unittest.TestCase):
    def test_timestamp_is_gmt_plus_eight(self):
        value = kye_official.format_timestamp(datetime(2026, 9, 11, 2, 3, 4, tzinfo=timezone.utc))
        self.assertEqual(value, "2026-09-11 10:03:04")

    def test_sign_is_uppercase_md5_of_exact_bytes(self):
        body = '{"客户":"测试"}'.encode("utf-8")
        expected = hashlib.md5("secret2026-09-11 10:03:04".encode("utf-8") + body).hexdigest().upper()
        self.assertEqual(kye_official.sign_request("secret", "2026-09-11 10:03:04", body), expected)

    def test_token_response_accepts_object_or_json_string(self):
        self.assertEqual(kye_official._token_from_response({"data": {"token": "abc"}}), "abc")
        self.assertEqual(kye_official._token_from_response({"data": json.dumps({"token": "xyz"})}), "xyz")

    def test_token_response_does_not_echo_credentials(self):
        with self.assertRaisesRegex(RuntimeError, "code=401"):
            kye_official._token_from_response({"code": 401, "msg": "denied", "data": None})

    def test_query_route_body_contains_authorized_identifiers(self):
        client = kye_official.KyeOfficialClient("key", "secret", "customer", "platform")
        captured = {}

        def fake_call(method, business, retry_token=True):
            captured.update({"method": method, "business": business})
            return {"code": 10000, "success": True}

        client._call = fake_call
        client.query_route(["KY4000000000001"])
        self.assertEqual(captured["method"], kye_official.QUERY_ROUTE_METHOD)
        self.assertEqual(captured["business"]["customerCode"], "customer")
        self.assertEqual(captured["business"]["platformFlag"], "platform")

    def test_subscribe_route_requests_route_pushes_for_authorized_customer(self):
        client = kye_official.KyeOfficialClient("key", "secret", "customer", "platform")
        captured = {}

        def fake_call(method, business, retry_token=True):
            captured.update({"method": method, "business": business})
            return {"code": 10000, "success": True}

        client._call = fake_call
        client.subscribe_route(["KY4000000000001", "KY4000000000002"])
        self.assertEqual(captured["method"], kye_official.SUBSCRIBE_ROUTE_METHOD)
        self.assertEqual(captured["business"]["waybillNumber"], ["KY4000000000001", "KY4000000000002"])
        self.assertEqual(captured["business"]["orderChannel"], "platform")
        self.assertEqual(captured["business"]["type"], ["10"])
        self.assertEqual(captured["business"]["customerCode"], "customer")

    def test_client_requests_token_then_sends_signed_business_request(self):
        calls = []
        original = kye_official._post_json

        def fake_post(url, body, headers, timeout):
            calls.append((url, body, headers, timeout))
            if url == kye_official.TOKEN_URLS["sandbox"]:
                return {"success": True, "data": {"token": "short-lived-token"}}
            return {"code": 10000, "success": True, "data": {}}

        kye_official._post_json = fake_post
        try:
            client = kye_official.KyeOfficialClient("key", "secret", "customer", "platform")
            response = client.query_route(["KY4000000000001"])
        finally:
            kye_official._post_json = original

        self.assertTrue(response["success"])
        self.assertEqual(len(calls), 2)
        token_body = json.loads(calls[0][1].decode("utf-8"))
        self.assertEqual(token_body, {"appkey": "key", "appsecret": "secret"})
        request_body = calls[1][1]
        request_headers = calls[1][2]
        self.assertEqual(request_headers["token"], "short-lived-token")
        self.assertEqual(request_headers["method"], kye_official.QUERY_ROUTE_METHOD)
        self.assertEqual(
            request_headers["sign"],
            kye_official.sign_request("secret", request_headers["timestamp"], request_body),
        )


if __name__ == "__main__":
    unittest.main()
