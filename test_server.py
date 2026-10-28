import http.client
import json
import threading
import unittest
from unittest.mock import patch, call
import os
os.environ.setdefault("REX_MOBILE_ORIGIN", "https://test.example.ts.net:8443")
os.environ.setdefault("REX_MOBILE_OWNER", "tester@example.com")
import server

S="session:00000000-0000-0000-0000-000000000000"
B="block:00000000-0000-0000-0000-000000000000"

class AccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()

    def request(self, method="GET", path="/api/sessions", data=None, **overrides):
        headers={"Host": server.urlsplit(server.ORIGIN).netloc,
                 "Tailscale-User-Login": server.OWNER,
                 "Origin": server.ORIGIN, "Content-Type":"application/json"}
        headers.update(overrides)
        headers={k:v for k,v in headers.items() if v is not None}
        c=http.client.HTTPConnection("127.0.0.1",self.http.server_port)
        c.request(method,path,body=json.dumps(data) if data is not None else None,headers=headers)
        r=c.getresponse()
        result=(r.status,r.read())
        c.close()
        return result

    @patch("server.OWNER", "")
    @patch("server.rex")
    def test_unconfigured_server_fails_closed(self,rex):
        self.assertEqual(self.request()[0],503)
        rex.assert_not_called()

    @patch("server.rex")
    def test_identity_required(self, rex):
        for identity in (None, "someone@example.com"):
            self.assertEqual(self.request(**{"Tailscale-User-Login":identity})[0],403)
        rex.assert_not_called()

    @patch("server.rex")
    def test_cross_site_and_host_rejected(self, rex):
        self.assertEqual(self.request(Host="evil.example")[0],403)
        self.assertEqual(self.request(**{"Sec-Fetch-Site":"cross-site"})[0],403)
        self.assertEqual(self.request("POST","/api/input",{"session":S,"block":B,"key":"enter"},Origin="https://evil.example")[0],403)
        rex.assert_not_called()

    @patch("server.rex", return_value="")
    def test_input_exact_target_no_shell(self, rex):
        text="$(touch /tmp/should-not-exist); echo hi"
        self.assertEqual(self.request("POST","/api/input",{"session":S,"block":B,"text":text})[0],200)
        rex.assert_called_once_with("send","-s",S,"-b",B,"--",text,raw=True)

    @patch("server.rex", return_value="")
    def test_terminal_data_preserves_control_bytes(self,rex):
        data="日本\x1b[D\r\x03"
        self.assertEqual(self.request("POST","/api/input",{"session":S,"block":B,"terminal_data":data})[0],200)
        rex.assert_called_once_with("send","-s",S,"-b",B,"--",data,raw=True)

    @patch("server.rex")
    def test_invalid_input_rejected(self,rex):
        for data in [{"session":S,"block":B,"key":"bad"}, {"session":S,"block":B,"text":"echo hi\necho bye"}, {"session":S,"block":"--help","text":"hi"}, {"session":S,"block":B,"text":"hi","key":"enter"}]:
            self.assertEqual(self.request("POST","/api/input",data)[0],400)
        rex.assert_not_called()

    @patch("server.rex", return_value="")
    def test_trailing_newlines_do_not_execute(self,rex):
        for text in ["who are you?\n\n", "who are you?\r\n"]:
            rex.reset_mock()
            self.assertEqual(self.request("POST","/api/input",{"session":S,"block":B,"text":text})[0],200)
            rex.assert_called_once_with("send","-s",S,"-b",B,"--","who are you?",raw=True)

    @patch("server.rex")
    def test_empty_and_embedded_controls_rejected(self,rex):
        for text in ["\n\r\n", "hello\x1b[200~", "hello\nworld"]:
            self.assertEqual(self.request("POST","/api/input",{"session":S,"block":B,"text":text})[0],400)
        rex.assert_not_called()

    @patch("server.rex", return_value="")
    def test_submit_text_then_enter(self,rex):
        self.assertEqual(self.request("POST","/api/input",{"session":S,"block":B,"text":"hello\n", "submit":True})[0],200)
        self.assertEqual(rex.call_args_list,[call("send","-s",S,"-b",B,"--","hello",raw=True),call("send-key","-s",S,"-b",B,"enter",raw=True)])

    @patch("server.rex", side_effect=RuntimeError())
    def test_failed_text_does_not_send_enter(self,rex):
        self.assertEqual(self.request("POST","/api/input",{"session":S,"block":B,"text":"hello", "submit":True})[0],502)
        self.assertEqual(rex.call_count,1)

    @patch("server.rex", side_effect=["", RuntimeError()])
    def test_failed_enter_is_not_retried(self,rex):
        status,body=self.request("POST","/api/input",{"session":S,"block":B,"text":"hello", "submit":True})
        self.assertEqual(status,502)
        self.assertIn("文字だけ",json.loads(body)["error"])
        self.assertEqual(rex.call_count,2)

    @patch("server.rex", side_effect=server.TargetUnavailable())
    def test_closed_target_returns_404(self,rex):
        self.assertEqual(self.request("GET",f"/api/screen?session={S}&block={B}")[0],404)
        self.assertEqual(self.request("POST","/api/input",{"session":S,"block":B,"key":"enter"})[0],404)

    @patch("server.rex", side_effect=FileNotFoundError())
    def test_missing_cli_explicit_failure(self,rex):
        self.assertEqual(self.request("POST","/api/input",{"session":S,"block":B,"key":"enter"})[0],502)

    @patch("server.rex")
    def test_capture_tail_from_same_blob(self,rex):
        rex.side_effect=[{"content":"old","id":9,"total":100000},{"data":"latest","eof":True}]
        self.assertEqual(server.screen(S,B),{"text":"latest","truncated":True})
        self.assertEqual(json.loads(rex.call_args.args[-1]),{"id":9,"offset":67232,"max_bytes":262144})

class TerminalTests(unittest.TestCase):
    @patch("server.rex")
    def test_formatter_row_separators_are_preserved(self,rex):
        size={"columns":80,"rows":24}
        rex.side_effect=[size,{"content":"top\r\nbottom\r\n\x1b[1;1H"},size]
        self.assertEqual(server.terminal_snapshot(S,B)["vt"],"top\r\nbottom\r\n\x1b[1;1H")

    @patch("server.rex")
    def test_vt_snapshot_preserves_full_blob_and_size(self, rex):
        size={"columns":80,"rows":24}
        rex.side_effect=[size,{"content":"日", "id":7,"total":6},{"data":"本"},size]
        self.assertEqual(server.terminal_snapshot(S,B),{"vt":"日本","columns":80,"rows":24,"transport":"snapshot"})
        self.assertEqual(json.loads(rex.call_args_list[2].args[-1])["offset"],3)
        args=json.loads(rex.call_args_list[1].args[-1])
        self.assertEqual(args["format"],"vt")
        self.assertTrue(args["extra_cursor"])

    @patch("server.rex")
    def test_resize_race_recaptures(self,rex):
        a={"columns":80,"rows":24}; b={"columns":90,"rows":30}
        rex.side_effect=[a,{"content":"old"},b,b,{"content":"new"},b]
        self.assertEqual(server.terminal_snapshot(S,B)["vt"],"new")

    @patch("server.rex")
    def test_incomplete_snapshot_fails(self,rex):
        rex.side_effect=[{"columns":80,"rows":24},{"content":"x","id":1,"total":2},{"data":""}]
        with self.assertRaises(RuntimeError): server.terminal_snapshot(S,B)

if __name__=="__main__":
    unittest.main()
