package vn.ghn.shipping;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.*;
import java.time.format.*;
import java.util.*;

final class JsonSupport {
  private static final DateTimeFormatter ISO = new DateTimeFormatterBuilder().appendInstant(3).toFormatter();
  static String now() { return iso(Instant.now()); }
  static String iso(Instant value) { return ISO.format(value); }
  static Instant instant(String value) {
    try { return OffsetDateTime.parse(value).toInstant(); }
    catch (Exception e) { throw new ApiProblem(400, "INVALID_EVENT_TIME"); }
  }
  static String write(ObjectMapper json, Object value) {
    try { return json.writeValueAsString(value); } catch (Exception e) { throw new IllegalStateException("JSON_WRITE_FAILED"); }
  }
  static JsonNode read(ObjectMapper json, String value) {
    try { return json.readTree(value); } catch (Exception e) { throw new IllegalStateException("JSON_READ_FAILED"); }
  }
  static JsonNode sorted(JsonNode input) {
    if (input.isObject()) {
      var result = JsonNodeFactory.instance.objectNode(); var keys = new TreeSet<String>(); input.fieldNames().forEachRemaining(keys::add);
      keys.forEach(key -> result.set(key, sorted(input.get(key)))); return result;
    }
    if (input.isArray()) { var result = JsonNodeFactory.instance.arrayNode(); input.forEach(row -> result.add(sorted(row))); return result; }
    return input;
  }
  static String hash(String value) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
    catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
  }
  static boolean equal(String a, String b) {
    return a != null && b != null && MessageDigest.isEqual(hash(a).getBytes(StandardCharsets.US_ASCII), hash(b).getBytes(StandardCharsets.US_ASCII));
  }
  static String text(JsonNode input, String field, int max) {
    var value = input.path(field);
    if (!value.isTextual() || value.asText().isBlank() || value.asText().length() > max) throw new ApiProblem(400, "INVALID_FIELD");
    return value.asText().trim();
  }
  static long integer(JsonNode input, String field, long min, long max) {
    var value = input.path(field);
    if (value.isNumber()) {
      try { long result=value.decimalValue().longValueExact(); if(result>=min && result<=max)return result; }
      catch(ArithmeticException ignored) { }
    }
    throw new ApiProblem(400, "INVALID_FIELD");
  }
  static Map<String,Object> map(Object... pairs) {
    var result = new LinkedHashMap<String,Object>();
    for (int i = 0; i < pairs.length; i += 2) result.put((String)pairs[i], pairs[i+1]);
    return result;
  }
  static String str(Map<String,Object> row, String key) { return row.get(key) == null ? null : row.get(key).toString(); }
}
