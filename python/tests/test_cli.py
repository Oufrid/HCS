import io
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hcs.cli import main  # noqa: E402


def run(*argv):
    out = io.StringIO()
    with redirect_stdout(out):
        code = main(list(argv))
    return code, out.getvalue()


class Cli(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="hcs-cli-")
        with open(os.path.join(self.dir, "rates.ts"), "w") as f:
            f.write("export function fee(w) {\n  return 25 + w * 4;\n}\n")
        self.file = os.path.join(self.dir, "project.hcs")
        with open(self.file, "w") as f:
            f.write("HCS/0.2\n@title t\n[claims]\n#c1 Fee is 25 plus 4 per kg.\n  > rates.ts::fee\n")

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_seal_check_render_and_staleness(self):
        self.assertEqual(run("check", self.file, "--strict")[0], 1, "unsealed fails in strict mode")
        self.assertEqual(run("seal", self.file)[0], 0)
        code, out = run("check", self.file, "--strict")
        self.assertEqual(code, 0, out)
        self.assertIn("OK: every claim still matches its sources.", out)
        self.assertIn("c1: Fee is 25 plus 4 per kg. (rates.ts::fee)", run("render", self.file)[1])
        with open(os.path.join(self.dir, "rates.ts"), "w") as f:
            f.write("export function fee(w) {\n  return 30 + w * 4;\n}\n")
        code, out = run("check", self.file)
        self.assertEqual(code, 1)
        self.assertIn("STALE", out)
        self.assertNotIn("c1:", run("render", self.file)[1])
        self.assertEqual(run("seal", self.file, "--rehash")[0], 0)
        self.assertEqual(run("check", self.file)[0], 0)

    def test_signed_certificates(self):
        import hashlib

        from hcs import parse, serialize
        from hcs.ed25519 import public_key
        from hcs.sign import _b64url_encode, sign_certificate

        run("seal", self.file)
        with open(self.file) as f:
            doc = parse(f.read())
        secret = hashlib.sha256(b"test").digest()
        cert = {"fields": {"model": "m:x", "fidelity": "0.800", "digest": "000000000000"}}
        pub = sign_certificate(cert, secret)
        self.assertEqual(pub, "ed25519:" + _b64url_encode(public_key(secret)))
        doc["certificates"].append(cert)
        with open(self.file, "w") as f:
            f.write(serialize(doc))
        trusted = os.path.join(self.dir, "trusted.txt")
        with open(trusted, "w") as f:
            f.write("team %s\n" % pub)
        code, out = run("check", self.file, "--trusted", trusted)
        self.assertEqual(code, 0, out)
        self.assertIn("signed by trusted key team", out)
        with open(self.file) as f:
            text = f.read()
        with open(self.file, "w") as f:
            f.write(text.replace("fidelity=0.800", "fidelity=0.990"))
        code, out = run("check", self.file, "--trusted", trusted)
        self.assertEqual(code, 1)
        self.assertIn("SIGNATURE INVALID", out)

    def test_usage_errors(self):
        self.assertEqual(run("check", os.path.join(self.dir, "missing.hcs"))[0], 2)
        with open(self.file, "w") as f:
            f.write("not hcs\n")
        self.assertEqual(run("validate", self.file)[0], 2)

    def test_tree_sitter_files_are_refused_not_misread(self):
        # Hashes made by another symbol parser could read as stale here: refuse instead of guessing.
        with open(self.file, "w") as f:
            f.write("HCS/0.3\n@title t\n@parser tree-sitter\n[claims]\n#c1 Fee.\n  > rates.ts::fee #000000000000\n")
        self.assertEqual(run("validate", self.file)[0], 0)
        for cmd in ("check", "seal", "render"):
            self.assertEqual(run(cmd, self.file)[0], 2, cmd)


if __name__ == "__main__":
    unittest.main()
