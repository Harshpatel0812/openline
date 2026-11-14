import { describe, expect, it } from "vitest";
import { detectDelimiter, mapHeaders, normalizeDomain, parseCsv } from "./csv";

describe("csv", () => {
  it("parses a simple comma file", () => {
    expect(parseCsv("email,name\na@x.com,Ann\nb@x.com,Ben")).toEqual({
      delimiter: ",",
      header: ["email", "name"],
      rows: [
        ["a@x.com", "Ann"],
        ["b@x.com", "Ben"],
      ],
    });
  });

  it("strips a UTF-8 BOM and handles CRLF", () => {
    const parsed = parseCsv("﻿Email,Name\r\na@x.com,Ann\r\n");
    expect(parsed.header).toEqual(["Email", "Name"]);
    expect(parsed.rows).toEqual([["a@x.com", "Ann"]]);
  });

  it("detects ; and tab delimiters from the header line, ignoring quoted ones", () => {
    expect(detectDelimiter("a;b;c\n1,2,3,4,5")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter('"a,b,c";d;e\n')).toBe(";");
    expect(detectDelimiter("single")).toBe(",");
    expect(parseCsv("email\tname\na@x.com\tAnn").rows).toEqual([["a@x.com", "Ann"]]);
  });

  it("handles quotes, escaped quotes, embedded delimiters and newlines", () => {
    const csv = 'a,b,c\n"x, y","say ""hi""","line1\r\nline2"\n';
    expect(parseCsv(csv).rows).toEqual([["x, y", 'say "hi"', "line1\r\nline2"]]);
  });

  it("trims cells, skips fully empty lines and keeps short rows", () => {
    const parsed = parseCsv("a,b\n  1 , 2 \n\n , \n3\n");
    expect(parsed.rows).toEqual([["1", "2"], ["3"]]);
  });

  it("handles an empty input and a header-only file", () => {
    expect(parseCsv("")).toEqual({ delimiter: ",", header: [], rows: [] });
    expect(parseCsv("email\n").rows).toEqual([]);
  });

  it("maps headers with synonyms, case, spaces and underscores", () => {
    expect(
      mapHeaders([
        "E-Mail",
        "first_name",
        "Surname",
        "Job Title",
        "Mobile",
        "TZ",
        "COUNTRY",
        "Organization",
        "Company Domain",
        "Notes",
        "email address",
      ]),
    ).toEqual([
      "email",
      "firstName",
      "lastName",
      "title",
      "phone",
      "timeZone",
      "country",
      "companyName",
      "companyDomain",
      null,
      null, // a second email column is ignored
    ]);
  });

  it("normalizes website values to a bare domain", () => {
    expect(normalizeDomain("https://www.Acme.com/about?x=1")).toBe("acme.com");
    expect(normalizeDomain("http://shop.acme.co.uk:8080")).toBe("shop.acme.co.uk");
    expect(normalizeDomain("www.globex.io/")).toBe("globex.io");
    expect(normalizeDomain("initech.com")).toBe("initech.com");
  });
});
