// SPDX-License-Identifier: Apache-2.0

/** Python/public Semantics finite Float64 canonical JSON representation. */
const floatExpression =
  "arrayMap(a -> arrayMap(b -> arrayMap(c -> arrayMap(d -> concat(a.2,if(d.1='0','0.0',if(d.2 < -4 OR d.2 >= 16,concat(substring(d.1,1,1),if(length(d.1)>1,concat('.',substring(d.1,2)),''),'e',if(d.2<0,'-','+'),leftPad(toString(abs(d.2)),greatest(2,length(toString(abs(d.2)))),'0')),if(d.2 < 0, concat('0.',repeat('0',toUInt64(-d.2-1)),d.1), if(length(d.1)<=d.2+1, concat(d.1,repeat('0',toUInt64(greatest(d.2+1-length(d.1),0))),'.0'), concat(substring(d.1,1,toUInt64(d.2+1)),'.',substring(d.1,toUInt64(d.2+2)))))))), [(if(c.1='','0',replaceRegexpOne(c.1,'0+$','')), b.3+c.2-toInt32(length(b.1)-length(c.1))-1)])[1], [(replaceRegexpOne(b.1,'^0+',''),b.2)])[1], [(replaceAll(a.1[1],'.',''),if(position(a.1[1],'.')=0,toInt32(length(a.1[1])),toInt32(position(a.1[1],'.'))-1),if(length(a.1)=2,toInt32(a.1[2]),0))])[1], [(splitByChar('e',toString(abs(x))),if(bitTest(reinterpretAsUInt64(x),63),'-',''))])[1]";

export function sqlString(value: string): string {
  return (
    "'" +
    Array.from(value, (c) => {
      const point = c.codePointAt(0)!;
      if (point < 32) return "\\x" + point.toString(16).padStart(2, "0");
      return c === "\\" ? "\\\\" : c === "'" ? "\\'" : c;
    }).join("") +
    "'"
  );
}

export function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) {
    throw new TypeError(
      "ClickHouse identifier must use the public physical name grammar",
    );
  }
  return "`" + value + "`";
}

export function canonicalSqlFunctions(prefix: string): readonly string[] {
  sqlIdentifier(prefix);
  const functionSql = (name: string, args: string, body: string) =>
    `CREATE FUNCTION IF NOT EXISTS ${prefix}_${name} AS ${args} -> ${body}`;
  const f = (name: string) => `${prefix}_${name}`;
  let quote = "x";
  const substitutions = [
    ["\\", "\\\\"],
    ['"', '\\"'],
  ];
  const short: Record<number, string> = {
    8: "b",
    9: "t",
    10: "n",
    12: "f",
    13: "r",
  };
  for (let i = 0; i < 32; i++)
    substitutions.push([
      String.fromCharCode(i),
      "\\" + (short[i] ?? "u" + i.toString(16).padStart(4, "0")),
    ]);
  for (const [before, after] of substitutions)
    quote = `replaceAll(${quote},${sqlString(before!)},${sqlString(after!)})`;
  const result = [
    functionSql("float", "x", floatExpression),
    functionSql("quote", "x", `concat('"',${quote},'"')`),
    functionSql(
      "object",
      "entries",
      `concat('{',arrayStringConcat(arrayMap(t -> concat(${f("quote")}(t.1),':',t.2),arraySort(t -> t.1,entries)),','),'}')`,
    ),
    functionSql(
      "array",
      "entries",
      "concat('[',arrayStringConcat(entries,','),']')",
    ),
  ];
  // Tokenize JSON instead of replacing inside quoted user strings. The private
  // marker cannot occur in valid OTLP protobuf JSON. It prevents ClickHouse's
  // repeated JSON extraction from erasing the sign of floating point zero.
  const tokens = String.raw`"(?:[^"\\]|\\.)*"|-?(?:0|[1-9][0-9]*)(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?|[{}\[\],:]|true|false|null`;
  result.push(
    functionSql(
      "protect_zero",
      "x",
      `arrayStringConcat(arrayMap(t -> if(match(t,'^-0([.]0+)?([eE][+-]?[0-9]+)?$'),'{"_meridian_negative_zero":true}',t),extractAll(x,${sqlString(tokens)})),'')`,
    ),
    functionSql(
      "number",
      "x",
      `if(JSONHas(x,'_meridian_negative_zero'),reinterpretAsFloat64(toUInt64('9223372036854775808')),JSONExtractFloat(x))`,
    ),
  );
  const frame = "Tuple(UInt8,String,Array(Tuple(String,String)),String)";
  result.push(
    functionSql(
      "emit",
      "(s,v)",
      `arrayMap(emit_head -> arrayPushBack(arrayPopBack(s),(emit_head.1,'',arrayPushBack(emit_head.3,(emit_head.2,v)),emit_head.4)),[arrayElement(s,-1)])[1]`,
    ),
    functionSql(
      "close",
      "a",
      `if(a.1,if(length(a.3)=1 AND a.3[1].1='_meridian_negative_zero','-0.0',${f("object")}(a.3)),${f("array")}(arrayMap(t -> t.2,if(has(['attributes','filteredAttributes','metadata','values'],a.4) AND arrayAll(t -> JSONHas(t.2,'key'),a.3),arraySort(t -> JSONExtractString(t.2,'key'),a.3),a.3))))`,
    ),
  );
  const scalar = `multiIf(startsWith(t,'"'),${f("quote")}(JSONExtractString(t)),t IN ('true','false','null'),t,has(['doubleValue','asDouble','sum','min','max','zeroThreshold','explicitBounds','value'],if(a.1,a.2,a.4)),${f("float")}(JSONExtractFloat(t)),t)`;
  const fold =
    `arrayMap(a -> multiIf(t IN ('{','['),arrayPushBack(s,(toUInt8(t='{'),'',CAST([], 'Array(Tuple(String,String))'),if(a.1,a.2,a.4))),
+t IN ('}',']'),${f("emit")}(arrayPopBack(s),${f("close")}(a)),
+t IN (',',':'),s,
+a.1 AND a.2='' AND startsWith(t,'"'),arrayPushBack(arrayPopBack(s),(a.1,JSONExtractString(t),a.3,a.4)),
+${f("emit")}(s,${scalar})),[arrayElement(s,-1)])[1]`.replaceAll("\n+", "\n");
  result.push(
    functionSql(
      "wire",
      "(x,k)",
      `arrayFold((s,t) -> ${fold},extractAll(x,${sqlString(tokens)}),CAST([(0,'',[] ,k)],'Array(${frame})'))[1].3[1].2`,
    ),
  );
  const anyFrame =
    "Tuple(UInt8,String,Array(Tuple(String,String)),String,UInt8)";
  const field = (key: string) => `arrayFirst(t -> t.1=${sqlString(key)},a.3).2`;
  const has = (key: string) => `arrayExists(t -> t.1=${sqlString(key)},a.3)`;
  const closeAny =
    `multiIf(NOT a.1,('',if(a.5,${f("object")}(a.3),${f("array")}(arrayMap(t -> t.2,a.3)))),
${has("key")},(JSONExtractString(${field("key")}),${field("value")}),
a.4 IN ('arrayValue','kvlistValue'),('',if(empty(a.3),if(a.4='arrayValue','[]','{}'),${field("values")})),
${has("_meridian_negative_zero")},('','-0.0'),
${has("intValue")},('',toString(toInt64OrZero(JSONExtractString(${field("intValue")})))),
${has("bytesValue")},('',${f("object")}([('base64',${field("bytesValue")}),('type','"bytes"')])),
('',if(empty(a.3),'null',a.3[1].2)))`.replaceAll("\n+", "\n");
  result.push(
    functionSql("any_close", "a", closeAny),
    functionSql(
      "any_emit",
      "(s,p)",
      `arrayMap(any_head -> arrayPushBack(arrayPopBack(s),(any_head.1,'',arrayPushBack(any_head.3,(if(any_head.1,any_head.2,p.1),p.2)),any_head.4,any_head.5)),[arrayElement(s,-1)])[1]`,
    ),
  );
  const anyScalar = `multiIf(startsWith(t,'"'),${f("quote")}(JSONExtractString(t)),t IN ('true','false','null'),t,a.2='doubleValue',${f("float")}(JSONExtractFloat(t)),t)`;
  const anyFold =
    `arrayMap(a -> multiIf(t IN ('{','['),arrayPushBack(s,(toUInt8(t='{'),'',CAST([], 'Array(Tuple(String,String))'),if(a.1,a.2,a.4),toUInt8(t='[' AND ((a.4='kvlistValue' AND a.2='values') OR (length(s)=1 AND k='attributes'))))),
t IN ('}',']'),${f("any_emit")}(arrayPopBack(s),${f("any_close")}(a)),
t IN (',',':'),s,
a.1 AND a.2='' AND startsWith(t,'"'),arrayPushBack(arrayPopBack(s),(a.1,JSONExtractString(t),a.3,a.4,a.5)),
${f("any_emit")}(s,('',${anyScalar}))),[arrayElement(s,-1)])[1]`.replaceAll(
      "\n+",
      "\n",
    );
  result.push(
    functionSql(
      "decode_any",
      "(x,k)",
      `arrayFold((s,t) -> ${anyFold},extractAll(x,${sqlString(tokens)}),CAST([(0,'',[],k,0)],'Array(${anyFrame})'))[1].3[1].2`,
    ),
    functionSql("any_12", "x", `${f("decode_any")}(x,'any')`),
    functionSql(
      "attributes",
      "x",
      `if(x='' OR x='{}','{}',${f("decode_any")}(x,'attributes'))`,
    ),
  );
  return result;
}
