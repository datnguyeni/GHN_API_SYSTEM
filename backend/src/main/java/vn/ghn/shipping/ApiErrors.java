package vn.ghn.shipping;

import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

@RestControllerAdvice
public class ApiErrors {
  @ExceptionHandler(Exception.class) ResponseEntity<?> handle(Exception error) {
    int status=500;String code="INTERNAL_ERROR";
    if(error instanceof ApiProblem p){status=p.status;code=p.code;}
    else if(error instanceof CarrierFailure c){status=502;code=c.code;}
    else if(error instanceof HttpMessageNotReadableException){status=400;code="INVALID_JSON";}
    else if(error instanceof MissingServletRequestParameterException || error instanceof MethodArgumentTypeMismatchException){status=400;code="INVALID_FIELD";}
    else if(error instanceof HttpMediaTypeNotSupportedException){status=415;code="JSON_REQUIRED";}
    else if(error instanceof NoResourceFoundException || error instanceof HttpRequestMethodNotSupportedException){status=404;code="NOT_FOUND";}
    return ResponseEntity.status(status).body(JsonSupport.map("code",code,"message",code));
  }
}
