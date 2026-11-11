package vn.ghn.shipping;

import jakarta.annotation.PreDestroy;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import static vn.ghn.shipping.JsonSupport.*;

@Component
public class WebhookDispatcher {
  @FunctionalInterface interface Sender { int post(String url,Map<String,String> headers,String body,int timeout) throws Exception; }
  private final Store db;
  private final ServiceConfig config;
  private final Sender sender;
  private final Clock clock;
  private final AtomicBoolean running=new AtomicBoolean();
  private volatile boolean stopped;
  @Autowired public WebhookDispatcher(Store db,ServiceConfig config) { this(db,config,httpSender(),Clock.systemUTC()); }
  WebhookDispatcher(Store db,ServiceConfig config,Sender sender,Clock clock) { this.db=db;this.config=config;this.sender=sender;this.clock=clock; }
  private static Sender httpSender() {
    var http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build();
    return (url,headers,body,timeout)->{
      var builder=HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofMillis(timeout)).POST(HttpRequest.BodyPublishers.ofString(body));
      headers.forEach(builder::header);
      var response=http.send(builder.build(),HttpResponse.BodyHandlers.ofInputStream());
      // Do not retain CRM response bodies or follow redirects to another endpoint.
      try(var stream=response.body()){return response.statusCode();}
    };
  }
  private record Work(Map<String,Object> row,ServiceConfig.Webhook target,int attempts) {}
  private Work claim() {
    var clients=config.clients().stream().filter(c->c.webhook()!=null && c.webhook().enabled()).toList();
    if(clients.isEmpty())return null;
    return db.tx(()->{
      String now=iso(clock.instant());
      db.update("UPDATE webhook_delivery SET status='PENDING',lease_until=NULL WHERE status='IN_FLIGHT' AND lease_until<=?",now);
      var args=new ArrayList<Object>();args.add(now);clients.forEach(c->args.add(c.id()));
      String placeholders=String.join(",",Collections.nCopies(clients.size(),"?"));
      var row=db.one("""
        SELECT w.* FROM webhook_delivery w WHERE w.status='PENDING' AND w.next_attempt_at<=?
        AND w.client IN (%s) AND NOT EXISTS(SELECT 1 FROM webhook_delivery earlier
          WHERE earlier.shipment_id=w.shipment_id AND earlier.sequence<w.sequence AND earlier.status IN ('PENDING','IN_FLIGHT'))
        ORDER BY w.sequence LIMIT 1
        """.formatted(placeholders),args.toArray());
      if(row==null)return null;
      var target=clients.stream().filter(c->c.id().equals(row.get("client"))).findFirst().orElseThrow().webhook();
      int attempts=((Number)row.get("attempts")).intValue();
      if(!target.url().equals(row.get("endpoint")) || attempts>=target.maxAttempts()) {
        db.update("UPDATE webhook_delivery SET status='FAILED',last_error=?,lease_until=NULL WHERE id=?",
          !target.url().equals(row.get("endpoint"))?"ENDPOINT_CHANGED":"MAX_ATTEMPTS_REACHED",row.get("id"));
        return new Work(row,null,attempts);
      }
      db.update("UPDATE webhook_delivery SET status='IN_FLIGHT',attempts=attempts+1,lease_until=? WHERE id=?",
        iso(clock.instant().plusMillis(target.timeoutMs()+5000L)),row.get("id"));
      return new Work(row,target,attempts+1);
    });
  }
  @Scheduled(fixedDelay=1000) public void tick() {
    if(stopped || !running.compareAndSet(false,true))return;
    try {
      for(int count=0;count<20 && !stopped && !Thread.currentThread().isInterrupted();count++) {
        var work=claim();if(work==null)break;if(work.target()==null)continue;
        var row=work.row();String body=str(row,"payload"),timestamp=Long.toString(clock.instant().getEpochSecond());
        Integer status=null;String error=null;
        try {
          status=sender.post(str(row,"endpoint"),Map.of("Content-Type","application/json","X-GHN-Service-Event-Id",str(row,"id"),
            "X-GHN-Service-Timestamp",timestamp,"X-GHN-Service-Signature",OutboundWebhooks.signature(work.target().secret(),timestamp,body.getBytes(StandardCharsets.UTF_8)),
            "X-GHN-Service-Attempt",Integer.toString(work.attempts())),body,work.target().timeoutMs());
          if(status<200 || status>=300)error="HTTP_"+status;
        } catch(InterruptedException e){Thread.currentThread().interrupt();error="NETWORK_OR_TIMEOUT";}
        catch(Exception e){error="NETWORK_OR_TIMEOUT";}
        if(error==null)db.update("UPDATE webhook_delivery SET status='DELIVERED',delivered_at=?,last_http_status=?,last_error=NULL,lease_until=NULL WHERE id=?",iso(clock.instant()),status,row.get("id"));
        else {
          long delay=(long)Math.min(work.target().maxDelayMs(),work.target().baseDelayMs()*Math.pow(2,work.attempts()-1));
          db.update("UPDATE webhook_delivery SET status=?,next_attempt_at=?,last_http_status=?,last_error=?,lease_until=NULL WHERE id=?",
            work.attempts()>=work.target().maxAttempts()?"FAILED":"PENDING",iso(clock.instant().plusMillis(delay)),status,error,row.get("id"));
        }
      }
    } catch(Exception error) { org.slf4j.LoggerFactory.getLogger(getClass()).error("WEBHOOK_DISPATCH_ERROR"); }
    finally{running.set(false);}
  }
  @PreDestroy public void stop(){stopped=true;}
}
