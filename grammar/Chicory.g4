grammar Chicory;

program
    : NL* stmt (NL+ stmt)* (NL+ exportStmt)? NL* EOF
    ;

stmt
    : assignStmt
    | typeDefinition
    | importStmt
    | expr
    ;

assignStmt
    : assignKwd IDENTIFIER '=' expr
    ;

// TODO: Force type identifier to begin with uppercase letter
typeDefinition
    : 'type' IDENTIFIER typeParams? '=' typeExpr
    ;

typeParams
    : '<' NL* IDENTIFIER (',' NL* IDENTIFIER)* NL* '>'
    ;

typeExpr
    : adtType
    | recordType
    | tupleType
    | primitiveType
    | functionType
    | genericTypeExpr
    ;

adtType: NL* '|'? adtOption (NL* '|' adtOption )* NL*;

adtOption
    : IDENTIFIER '(' NL* '{' NL* adtTypeAnnotation (',' NL* adtTypeAnnotation) ','? NL* '}' NL* ')' #AdtOptionAnonymousRecord
    | IDENTIFIER '(' IDENTIFIER ')'                                                                 #AdtOptionNamedType
    | IDENTIFIER '(' primitiveType ')'                                                              #AdtOptionPrimitiveType
    | IDENTIFIER                                                                                    #AdtOptionNoArg
    ;

adtTypeAnnotation: IDENTIFIER ':' (primitiveType | IDENTIFIER);

recordType: '{' NL* recordTypeAnontation (',' NL* recordTypeAnontation)* ','? NL* '}';

recordTypeAnontation: IDENTIFIER ':' (primitiveType | recordType | IDENTIFIER);

tupleType: '[' NL* typeExpr (',' NL* typeExpr)* ','? NL* ']';

primitiveType: 'number' | 'string' | 'boolean' | 'unit';

functionType: '(' NL* (typeParam (',' NL* typeParam)*)? NL* ')' '=>' NL* typeExpr;

typeParam
    : IDENTIFIER ':' typeExpr  #NamedTypeParam
    | typeExpr                 #UnnamedTypeParam
    ;

genericTypeExpr
    : IDENTIFIER '<' NL* typeExpr (',' NL* typeExpr)* NL* '>'
    ;

importStmt
    : 'import' IDENTIFIER 'from' STRING
    | 'import' IDENTIFIER ',' destructuringImportIdentifier 'from' STRING
    | 'import' destructuringImportIdentifier 'from' STRING
    | 'bind' IDENTIFIER 'as' typeExpr 'from' STRING
    | 'bind' bindingImportIdentifier 'from' STRING
    | 'bind' IDENTIFIER 'as' typeExpr ',' bindingImportIdentifier 'from' STRING
    ;

destructuringImportIdentifier:
    | '{' NL* IDENTIFIER (',' NL* IDENTIFIER)* NL* '}'
    ;

bindingImportIdentifier:
    '{' NL* bindingIdentifier (',' NL* bindingIdentifier)* NL* '}'
    ;

bindingIdentifier:
    IDENTIFIER 'as' typeExpr
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
    | blockExpr         #BlockExpression
    | recordExpr        #RecordExpression
    | arrayLikeExpr     #ArrayLikeExpression
    | IDENTIFIER        #IdentifierExpression
    | literal           #LiteralExpression
    | '(' expr ')'      #ParenExpression
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
    : '(' NL* parameterList? NL* ')' '=>' NL* expr
    ;

parameterList
    : IDENTIFIER (',' IDENTIFIER)*
    ;

callExpr
    : '(' NL* (expr (',' NL* expr)*)? NL* ')'
    ;

matchExpr
    : 'match' '(' expr ')' '{' NL* matchArm (',' NL* matchArm)* ','? NL* '}'
    ;

matchArm
    : matchPattern '=>' expr
    ;

matchPattern
    : IDENTIFIER                    #BareAdtMatchPattern
    | IDENTIFIER '(' IDENTIFIER ')' #AdtWithParamMatchPattern
    | IDENTIFIER '(' literal ')'    #AdtWithLiteralMatchPattern
    | '_'                           #WildcardMatchPattern
    | literal                       #LiteralMatchPattern
    ;

blockExpr
    : '{' NL* (stmt NL+)* expr NL* '}'
    ;

recordExpr
    : '{' NL* (recordKvExpr (',' NL* recordKvExpr)*)? ','? NL* '}'
    ;

recordKvExpr: IDENTIFIER ':' expr;

arrayLikeExpr
    : '[' NL* (expr NL* (',' NL* expr)*)? NL* ','? NL* ']'
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
    : IDENTIFIER '=' jsxAttributeValue
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

OPERATOR: '+' | '-' | '*' | '/' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '&&' | '||';

// TODO: Handle escaping
STRING: '"' (~["\n])* '"';

NUMBER: [0-9]+ ('.' [0-9]+)?;

NL: '\n';
WS: [ \r\t]+ -> channel(HIDDEN);

COMMENT: '//' ~[\n]* -> channel(HIDDEN);
MULTILINE_COMMENT: '/*' .*? '*/' -> channel(HIDDEN);
