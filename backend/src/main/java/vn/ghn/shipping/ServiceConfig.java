package vn.ghn.shipping;

import com.fasterxml.jackson.databind.JsonNode;
import java.net.URI;
import java.util.*;
import static vn.ghn.shipping.JsonSupport.*;

public record ServiceConfig(List<Client> clients, List<Shop> shops, String mode) {
  public record Client(String id, String token, List<String> shops, Webhook webhook) {}
  public record Shop(String code, String name, long shopId, String environment, String token, String webhookSecret, JsonNode sender, JsonNode returnAddress) {}
  public record Webhook(boolean enabled, String url, String secret, int timeoutMs, int maxAttempts, int baseDelayMs, int maxDelayMs) {}

  public static ServiceConfig load(JsonNode root, String mode) {
    try { return validated(root, mode); }
    catch (Exception error) { throw new IllegalArgumentException("Invalid shipping configuration; check client/shop/webhook settings (secrets omitted)"); }
  }
  private static ServiceConfig validated(JsonNode root, String mode) {
    if (!Set.of("live","mock").contains(mode) || !root.path("clients").isArray() || root.path("clients").isEmpty() || !root.path("shops").isArray()) throw new IllegalArgumentException();
    var shops = new ArrayList<Shop>(); var codes = new HashSet<String>(); var ids = new HashSet<Long>();
    for (var row : root.path("shops")) {
      String code = text(row,"code",80), env = text(row,"environment",20), token = text(row,"token",4096), secret = text(row,"webhookSecret",4096);
      long id = integer(row,"shopId",1,9007199254740991L);
      if (!code.matches("[A-Za-z0-9_-]+") || !codes.add(code) || !ids.add(id) || !Set.of("STAGING","PRODUCTION").contains(env) || secret.length()<32) throw new IllegalArgumentException();
      rejectExample(mode,token); rejectExample(mode,secret);
      shops.add(new Shop(code,text(row,"name",250),id,env,token,secret,Contract.address(row.path("sender")),
        row.hasNonNull("returnAddress") ? Contract.address(row.path("returnAddress")) : null));
    }
    var clients = new ArrayList<Client>(); var clientIds = new HashSet<String>(); var tokens = new HashSet<String>();
    for (var row : root.path("clients")) {
      String id = text(row,"id",80), token = text(row,"token",4096);
      if (!id.matches("[A-Za-z0-9_-]+") || !clientIds.add(id) || token.length()<32 || !tokens.add(token) || !row.path("shops").isArray()) throw new IllegalArgumentException();
      rejectExample(mode,token);
      var access = new ArrayList<String>();
      for (var code : row.path("shops")) { if (!code.isTextual() || !codes.contains(code.asText())) throw new IllegalArgumentException(); access.add(code.asText()); }
      clients.add(new Client(id,token,List.copyOf(access),webhook(row.path("webhook"))));
    }
    return new ServiceConfig(List.copyOf(clients),List.copyOf(shops),mode);
  }
  private static void rejectExample(String mode, String value) {
    if (mode.equals("live") && (value.startsWith("REPLACE_") || value.startsWith("demo-"))) throw new IllegalArgumentException();
  }
  private static int setting(JsonNode node, String key, int fallback, int min, int max) { return node.has(key) ? (int)integer(node,key,min,max) : fallback; }
  private static Webhook webhook(JsonNode node) {
    if (node.isMissingNode()) return null;
    if (!node.isObject() || !node.path("enabled").isBoolean()) throw new IllegalArgumentException();
    boolean enabled = node.path("enabled").asBoolean();
    String url = node.path("url").asText(""), secret = node.path("secret").asText("");
    int timeout = setting(node,"timeoutMs",10000,100,30000), attempts = setting(node,"maxAttempts",12,1,50),
      base = setting(node,"baseDelayMs",5000,100,3600000), max = setting(node,"maxDelayMs",3600000,100,86400000);
    if (max < base) throw new IllegalArgumentException();
    if (enabled) {
      URI uri = URI.create(url);
      boolean local = "http".equals(uri.getScheme()) && Set.of("localhost","127.0.0.1","[::1]").contains(Objects.toString(uri.getHost(),""));
      if ((!local && !"https".equals(uri.getScheme())) || uri.getHost()==null || uri.getUserInfo()!=null || uri.getFragment()!=null || secret.length()<32 || secret.startsWith("REPLACE_")) throw new IllegalArgumentException();
    }
    return new Webhook(enabled,url,secret,timeout,attempts,base,max);
  }
}
