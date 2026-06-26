import test from "node:test";
import assert from "node:assert/strict";

import { extractDomain } from "../rdap-client";

test("extractDomain returns the registrable domain for plain and multi-level TLDs", () => {
  assert.equal(extractDomain("https://www.example.com/path"), "example.com");
  assert.equal(extractDomain("subdomain.example.co.uk"), "example.co.uk");
  assert.equal(extractDomain("api.staging.exit1.dev"), "exit1.dev");
  assert.equal(extractDomain("example.com"), "example.com");
});

// Regression: every registro.br category — not just .com.br — must collapse to
// the registered eTLD+1, otherwise domain checks query the bare suffix and fail.
// https://registro.br/dominio/categorias/
test("extractDomain handles all .br categories, not only .com.br", () => {
  assert.equal(extractDomain("loja.empresa.com.br"), "empresa.com.br");
  assert.equal(extractDomain("https://www.site.net.br/x"), "site.net.br");
  assert.equal(extractDomain("blog.minhaong.org.br"), "minhaong.org.br");
  assert.equal(extractDomain("perfil.empresa.social.br"), "empresa.social.br");
  assert.equal(extractDomain("advogado.adv.br"), "advogado.adv.br");
  assert.equal(extractDomain("clinica.med.br"), "clinica.med.br");
  assert.equal(extractDomain("app.dev.br"), "app.dev.br");
});

test("extractDomain rejects IP addresses, bare hostnames, and empty input", () => {
  assert.equal(extractDomain("192.168.1.1"), null);
  assert.equal(extractDomain("2001:db8::1"), null);
  assert.equal(extractDomain("localhost"), null);
  assert.equal(extractDomain(""), null);
});
