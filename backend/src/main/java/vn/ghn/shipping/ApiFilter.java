package vn.ghn.shipping;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(-100)
public class ApiFilter extends OncePerRequestFilter {
  private final ShippingService service;
  private final ObjectMapper json;
  public ApiFilter(ShippingService service,ObjectMapper json){this.service=service;this.json=json;}
  @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws ServletException,IOException {
    response.setHeader("X-Content-Type-Options","nosniff");response.setHeader("Referrer-Policy","no-referrer");
    boolean api=request.getRequestURI().startsWith("/internal/") || request.getRequestURI().startsWith("/webhooks/") || request.getRequestURI().equals("/health");
    if(api)response.setHeader("Cache-Control","no-store");
    try {
      if(request.getRequestURI().startsWith("/internal/"))request.setAttribute("client",service.authenticate(request.getHeader("Authorization")));
      if(api && request.getMethod().equals("POST")) {
        final int max=256*1024;
        if(request.getContentLengthLong()>max)throw new ApiProblem(413,"BODY_TOO_LARGE");
        byte[] bytes=request.getInputStream().readNBytes(max+1);
        if(bytes.length>max)throw new ApiProblem(413,"BODY_TOO_LARGE");
        request=new HttpServletRequestWrapper(request){
          @Override public ServletInputStream getInputStream(){
            var input=new ByteArrayInputStream(bytes);
            return new ServletInputStream(){
              @Override public int read(){return input.read();}
              @Override public int read(byte[] b,int off,int len){return input.read(b,off,len);}
              @Override public boolean isFinished(){return input.available()==0;}
              @Override public boolean isReady(){return true;}
              @Override public void setReadListener(ReadListener listener){throw new UnsupportedOperationException();}
            };
          }
          @Override public BufferedReader getReader(){return new BufferedReader(new InputStreamReader(getInputStream(),StandardCharsets.UTF_8));}
        };
      }
      chain.doFilter(request,response);
    } catch(ApiProblem error){
      response.setStatus(error.status);response.setContentType("application/json;charset=UTF-8");json.writeValue(response.getOutputStream(),JsonSupport.map("code",error.code,"message",error.code));
    }
  }
}
