grammar Chicory;

program
    : NL* stmt (NL+ stmt)* (NL+ exportStmt)? NL* EOF
    ;

stmt
    : assignStmt
    | mutateStmt
    | typeDefinition
    | importStmt
    | globalStmt
    | expr
    ;

assignStmt
    : assignKwd assignTarget (':' typeExpr)? '=' expr
    ;

mutateStmt: IDENTIFIER identifierTailExpr* '=' expr;

identifierTailExpr
    : '.' IDENTIFIER    #IdentifierTailMemberExpression
    | '[' expr ']'      #IdentifierTailIndexExpression
    ;

// TODO: Force type identifier to begin with uppercase letter
typeDefinition
    : 'type' IDENTIFIER typeParams? '=' typeExpr
    ;

typeParams
    : '<' NL* IDENTIFIER (',' NL* IDENTIFIER)* NL* '>'
    ;

typeExpr
    : primaryTypeExpr ( '[]' )*
    ;

primaryTypeExpr
    : adtType
    | recordType
    | tupleType
    | primitiveType
    | functionType
    | genericTypeExpr
    | literalUnionType
    | IDENTIFIER
    | '(' typeExpr ')'
    ;

// Union of string literal types, e.g., "user" | "admin"
literalUnionType
    : stringLiteralType (NL* '|' NL* stringLiteralType)*
    ;

stringLiteralType
    : STRING
    ;

adtType: NL* '|'? adtOption (NL* '|' adtOption )* NL*;

adtOption
    : IDENTIFIER '(' NL* '{' NL* adtTypeAnnotation (',' NL* adtTypeAnnotation)? ','? NL* '}' NL* ')' #AdtOptionAnonymousRecord
    | IDENTIFIER '(' IDENTIFIER ')'                                                                 #AdtOptionNamedType
    | IDENTIFIER '(' primitiveType ')'                                                              #AdtOptionPrimitiveType
    | IDENTIFIER                                                                                    #AdtOptionNoArg
    ;

adtTypeAnnotation: IDENTIFIER ':' (primitiveType | IDENTIFIER);

recordType: '{' NL* recordTypeAnnotation (',' NL* recordTypeAnnotation)* ','? NL* '}';

recordTypeAnnotation: IDENTIFIER QUESTION? ':' (primitiveType | recordType | IDENTIFIER | tupleType | functionType | genericTypeExpr);

tupleType: '[' NL* typeExpr (',' NL* typeExpr)* ','? NL* ']';

primitiveType: 'number' | 'string' | 'boolean' | 'void';

functionType: '(' NL* (typeParam (',' NL* typeParam)*)? NL* ')' '=>' NL* typeExpr;

typeParam
    : IDENTIFIER ':' typeExpr  #NamedTypeParam
    | typeExpr                 #UnnamedTypeParam
    ;

genericTypeExpr
    : IDENTIFIER '<' NL* typeExpr (',' NL* typeExpr)* NL* '>'
    ;

importStmt
    : 'import' IDENTIFIER 'from' STRING                                     #ImportStatement
    | 'import' IDENTIFIER ',' destructuringImportIdentifier 'from' STRING   #ImportStatement
    | 'import' destructuringImportIdentifier 'from' STRING                  #ImportStatement
    | 'bind' IDENTIFIER 'as' typeExpr 'from' STRING                         #BindStatement
    | 'bind' bindingImportIdentifier 'from' STRING                          #BindStatement
    | 'bind' IDENTIFIER 'as' typeExpr ',' bindingImportIdentifier 'from' STRING #BindStatement
    ;

globalStmt: 'global' IDENTIFIER 'as' typeExpr;

destructuringImportIdentifier:
    | '{' NL* IDENTIFIER (',' NL* IDENTIFIER)* NL* '}'
    ;

bindingImportIdentifier:
    '{' NL* bindingIdentifier (',' NL* bindingIdentifier)* NL* '}'
    ;

bindingIdentifier:
    IDENTIFIER 'as' typeExpr
    ;

assignTarget
    : IDENTIFIER
    | recordDestructuringPattern
    | arrayDestructuringPattern
    ;

recordDestructuringPattern
    : '{' NL* IDENTIFIER (',' NL* IDENTIFIER)* ','? NL* '}'
    ;

arrayDestructuringPattern
    : '[' NL* IDENTIFIER (',' NL* IDENTIFIER)* ','? NL* ']'
    ;

exportStmt
    : 'export' '{' NL* IDENTIFIER (',' NL* IDENTIFIER)* ','? NL* '}'
    ;

expr: primaryExpr tailExpr*;

primaryExpr
    : ifExpr            #IfExpression
    | funcExpr          #FunctionExpression
    | jsxExpr           #JsxExpression
    | matchExpr         #MatchExpression
    | recordExpr        #RecordExpression
    | blockExpr         #BlockExpression
    | arrayLikeExpr     #ArrayLikeExpression
    | IDENTIFIER        #IdentifierExpression
    | literal           #LiteralExpression
    | '(' NL* expr NL* ')'      #ParenExpression
    ;

tailExpr
    : '.' IDENTIFIER    #MemberExpression
    | '[' expr ']'      #IndexExpression
    | callExpr          #CallExpression
    | OPERATOR expr     #OperationExpression
    ;

ifExpr: justIfExpr ('else' justIfExpr)* ('else' expr)?;

justIfExpr
    : 'if' '(' expr ')' expr
    ;

funcExpr
    : '(' NL* parameterList? NL* ')' '=>' NL* expr  #ParenFunctionExpression
    | IDENTIFIER '=>' NL* expr                      #ParenlessFunctionExpression
    | '(' '_' ')' '=>' NL* expr                     #ParenFunctionExpressionWildcard
    | '_' '=>' NL* expr                             #ParenlessFunctionExpressionWildcard
    ;

parameterList
    : idOrWild (',' idOrWild)*
    ;

idOrWild: IDENTIFIER | '_';

callExpr
    : '(' NL* (expr (',' NL* expr)*)? NL* ')'
    ;

matchExpr
    : 'match' '(' expr ')' '{' NL* matchArm (NL+ matchArm)* NL* '}'
    ;

matchArm
    : matchPattern '=>' expr
    ;

matchPattern
    : IDENTIFIER '(' '_' ')'        #AdtWithWildcardMatchPattern
    | IDENTIFIER '(' IDENTIFIER ')' #AdtWithParamMatchPattern
    | IDENTIFIER '(' literal ')'    #AdtWithLiteralMatchPattern
    | IDENTIFIER                    #BareAdtOrVariableMatchPattern
    | '_'                           #WildcardMatchPattern
    | literal                       #LiteralMatchPattern
    ;

blockExpr
    : '{' NL* (stmt NL*)* '}'
    ;

recordExpr
    : '{' NL* (recordKvExpr (',' NL* recordKvExpr)*)? ','? NL* '}'
    ;

recordKvExpr: IDENTIFIER ':' expr;

arrayLikeExpr
    : '[' NL* (expr NL* (',' NL* expr)*)? NL* ','? NL* ']'
    | '[]'
    ;

assignKwd
    : LET_KWD
    | CONST_KWD
    ;

literal
    : STRING    #StringLiteral
    | NUMBER    #NumberLiteral
    | TRUE_KWD  #BooleanLiteral
    | FALSE_KWD #BooleanLiteral
    ;

// TODO: Very simplistic handling of jsx...
jsxExpr
    : jsxOpeningElement NL* (NL* jsxChild)* NL* jsxClosingElement
    | jsxSelfClosingElement
    ;

jsxOpeningElement
    : '<' IDENTIFIER NL* jsxAttributes? NL* '>'
    ;

jsxClosingElement
    : '</' IDENTIFIER '>'
    ;

jsxSelfClosingElement
    : '<' IDENTIFIER NL* jsxAttributes? NL* '/>'
    ;

jsxAttributes
    : jsxAttribute (NL* jsxAttribute)*
    ;

jsxAttribute
    : 'type' '=' jsxAttributeValue
    | IDENTIFIER '=' jsxAttributeValue
    ;

jsxAttributeValue
    : '{' expr '}'
    | STRING
    | NUMBER
    ;

jsxChild
    : jsxExpr       #JsxChildJsx
    | '{' expr '}'  #JsxChildExpression
    | ~('<' | '{')+ #JsxChildText
    ;


// LEXING

LET_KWD: 'let';
CONST_KWD: 'const';
TRUE_KWD: 'true';
FALSE_KWD: 'false';

IDENTIFIER: [a-zA-Z_][a-zA-Z0-9_]*;

QUESTION: '?';

OPERATOR: '+' | '-' | '*' | '/' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '&&' | '||';

// TODO: Handle escaping
STRING: '"' (~["\n])* '"';

NUMBER: '-'? [0-9]+ ('.' [0-9]+)?;

NL: '\n';
WS: [ \r\t]+ -> channel(HIDDEN);

COMMENT: '//' ~[\n]* -> channel(HIDDEN);
MULTILINE_COMMENT: '/*' .*? '*/' -> channel(HIDDEN);
