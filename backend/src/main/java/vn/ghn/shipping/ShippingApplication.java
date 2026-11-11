package vn.ghn.shipping;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.*;
import javax.sql.DataSource;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.web.servlet.config.annotation.*;

@EnableScheduling
@SpringBootApplication
public class ShippingApplication {
  public static void main(String[] args) { SpringApplication.run(ShippingApplication.class, args); }

  @Bean ServiceConfig serviceConfig(ObjectMapper json,
      @Value("${shipping.config-file}") String file, @Value("${shipping.mode}") String mode) throws Exception {
    return ServiceConfig.load(json.readTree(Files.readString(Path.of(file))), mode);
  }
  @Bean(destroyMethod="destroy") DataSource dataSource(@Value("${shipping.db-path}") String file) throws Exception {
    if (!file.equals(":memory:")) Files.createDirectories(Path.of(file).toAbsolutePath().getParent());
    Class.forName("org.sqlite.JDBC");
    return new SingleConnectionDataSource("jdbc:sqlite:" + file, true);
  }
  @Bean Carrier carrier(ObjectMapper json, ServiceConfig config) {
    return config.mode().equals("mock") ? new MockCarrier(json) : new GhnCarrier(json);
  }
  @Bean WebMvcConfigurer staticFiles(@Value("${shipping.static-dir}") String directory) {
    return new WebMvcConfigurer() {
      @Override public void addResourceHandlers(ResourceHandlerRegistry registry) {
        registry.addResourceHandler("/**").addResourceLocations(Path.of(directory).toAbsolutePath().toUri().toString() + "/","classpath:/static/");
      }
      @Override public void addViewControllers(ViewControllerRegistry registry) { registry.addViewController("/").setViewName("forward:/index.html"); }
    };
  }
}
