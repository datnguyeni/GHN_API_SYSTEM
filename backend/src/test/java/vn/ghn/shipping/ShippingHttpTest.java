package vn.ghn.shipping;

import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.*;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties={"shipping.mode=mock","shipping.config-file=../config/demo.json","shipping.db-path=:memory:","shipping.static-dir=../out"})
class ShippingHttpTest {
  @Autowired TestRestTemplate http;
  @Autowired ObjectMapper json;
  final String prefix="/internal/shipping/ghn";
  HttpHeaders headers(){var h=new HttpHeaders();h.setBearerAuth("demo-only-service-access-token-1234567890");h.setContentType(MediaType.APPLICATION_JSON);return h;}
  @Test void realSpringHttpContract() throws Exception {
    assertEquals(401,http.getForEntity(prefix+"/shops",String.class).getStatusCode().value());
    assertEquals("mock",http.getForObject("/health",JsonNode.class).path("mode").asText());
    var shops=http.exchange(prefix+"/shops",HttpMethod.GET,new HttpEntity<>(headers()),JsonNode.class).getBody();
    assertEquals("HCM-01",shops.get(0).path("code").asText());assertFalse(shops.get(0).has("token"));
    var body=json.readTree(getClass().getResourceAsStream("/legacy-contract.json")).path("input");
    assertEquals(400,http.postForEntity(prefix+"/create-order",new HttpEntity<>(body,headers()),String.class).getStatusCode().value());
    var h=headers();h.set("Idempotency-Key","http-contract");
    var create=http.postForEntity(prefix+"/create-order",new HttpEntity<>(body,h),JsonNode.class);assertEquals(201,create.getStatusCode().value());
    String id=create.getBody().path("id").asText();assertEquals("CREATED",create.getBody().path("state").asText());
    assertEquals(200,http.exchange(prefix+"/shipments/"+id,HttpMethod.GET,new HttpEntity<>(headers()),String.class).getStatusCode().value());
    assertEquals(200,http.postForEntity(prefix+"/shipments/"+id+"/reconcile",new HttpEntity<>(headers()),String.class).getStatusCode().value());
    var settings=http.exchange(prefix+"/webhook",HttpMethod.GET,new HttpEntity<>(headers()),JsonNode.class).getBody();assertFalse(settings.path("enabled").asBoolean());assertFalse(settings.has("secret"));
    assertEquals(200,http.exchange(prefix+"/webhook/deliveries",HttpMethod.GET,new HttpEntity<>(headers()),String.class).getStatusCode().value());
  }
  @Test void rejectsMalformedJsonUnsupportedContentTypeAndOversizedBodies(){
    assertEquals(400,http.postForEntity(prefix+"/create-order",new HttpEntity<>("not-json",headers()),String.class).getStatusCode().value());
    var wrong=headers();wrong.setContentType(MediaType.TEXT_PLAIN);
    assertEquals(415,http.postForEntity(prefix+"/create-order",new HttpEntity<>("{}",wrong),String.class).getStatusCode().value());
    assertEquals(413,http.postForEntity(prefix+"/create-order",new HttpEntity<>("x".repeat(270000),headers()),String.class).getStatusCode().value());
    assertEquals(404,http.exchange(prefix+"/unknown",HttpMethod.GET,new HttpEntity<>(headers()),String.class).getStatusCode().value());
  }
}
