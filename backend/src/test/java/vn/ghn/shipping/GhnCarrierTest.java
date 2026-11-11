package vn.ghn.shipping;

import com.fasterxml.jackson.databind.*;
import java.net.http.*;
import java.nio.file.*;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

@SuppressWarnings({"unchecked","rawtypes"})
class GhnCarrierTest {
  @Test void fixedOriginPathsHeadersAndSanitizedFailures() throws Exception {
    var json=new ObjectMapper();var config=ServiceConfig.load(json.readTree(Files.readString(Path.of("../config/demo.json"))),"mock");
    var http=mock(HttpClient.class);HttpResponse response=mock(HttpResponse.class);
    when(response.statusCode()).thenReturn(200);when(response.body()).thenReturn("{\"code\":200,\"data\":{\"order_code\":\"GHN1\"}}");
    when(http.send(any(HttpRequest.class),any(HttpResponse.BodyHandler.class))).thenReturn(response);
    var carrier=new GhnCarrier(json,http);carrier.create(config.shops().getFirst(),json.createObjectNode());carrier.lookup(config.shops().getFirst(),"internal-id");
    var requests=ArgumentCaptor.forClass(HttpRequest.class);verify(http,times(2)).send(requests.capture(),any(HttpResponse.BodyHandler.class));
    assertEquals("https://dev-online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/create",requests.getAllValues().get(0).uri().toString());
    assertEquals("demo-not-a-real-ghn-token",requests.getValue().headers().firstValue("Token").orElseThrow());
    assertEquals("GET",requests.getValue().method());assertTrue(requests.getValue().uri().toString().endsWith("detail-by-client-code?client_order_code=internal-id"));
    when(response.statusCode()).thenReturn(503);when(response.body()).thenReturn("private token recipient");
    var failure=assertThrows(CarrierFailure.class,()->carrier.create(config.shops().getFirst(),json.createObjectNode()));assertTrue(failure.unknown);assertEquals("GHN_HTTP_503",failure.code);
    when(response.statusCode()).thenReturn(200);when(response.body()).thenReturn("not json");
    assertTrue(assertThrows(CarrierFailure.class,()->carrier.create(config.shops().getFirst(),json.createObjectNode())).unknown);
  }
}
