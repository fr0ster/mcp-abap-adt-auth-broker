@requires: 'User'
@odata service CatalogService {
  entity Books { 
    key ID:Integer; title:String; author:String;
  }
  action echo(text: String) returns String;
} 
